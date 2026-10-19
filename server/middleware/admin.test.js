const admin = require('./admin');

const response = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};
const request = metadata => ({ currentUser: { attributes: { profile: { metadata } } } });

describe('admin middleware', () => {
  it('lets admins through', () => {
    const next = jest.fn();
    admin(request({ isAdmin: true }), response(), next);
    expect(next).toHaveBeenCalled();
  });

  it.each([[undefined], [{}], [{ isAdmin: 'true' }], [{ isAdmin: 1 }], [{ isAdmin: false }]])(
    'responds 403 for metadata %p',
    metadata => {
      const next = jest.fn();
      const res = response();
      admin(request(metadata), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    }
  );

  it('responds 403 without a signed-in user', () => {
    const next = jest.fn();
    const res = response();
    admin({}, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
