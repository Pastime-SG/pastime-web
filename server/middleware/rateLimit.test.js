const { createRateLimit } = require('./rateLimit');

const createResponse = () => {
  const res = { headers: {} };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.set = jest.fn((name, value) => {
    res.headers[name] = value;
    return res;
  });
  return res;
};

describe('createRateLimit', () => {
  it('allows max requests per window and key, then answers 429', () => {
    let time = 0;
    const limit = createRateLimit({ windowMs: 60000, max: 2, now: () => time });
    const req = { tokenUserId: 'user-1' };
    const next = jest.fn();

    limit(req, createResponse(), next);
    limit(req, createResponse(), next);
    const res = createResponse();
    limit(req, res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.headers['Retry-After']).toBe('60');

    // Another user has their own count
    limit({ tokenUserId: 'user-2' }, createResponse(), next);
    expect(next).toHaveBeenCalledTimes(3);

    // A new window starts after windowMs
    time = 60001;
    limit(req, createResponse(), next);
    expect(next).toHaveBeenCalledTimes(4);
  });

  it('counts by IP address without a signed-in user', () => {
    const limit = createRateLimit({ windowMs: 1000, max: 1, now: () => 0 });
    const next = jest.fn();
    limit({ ip: '1.2.3.4' }, createResponse(), next);
    const res = createResponse();
    limit({ ip: '1.2.3.4' }, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    limit({ ip: '5.6.7.8' }, createResponse(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });
});
