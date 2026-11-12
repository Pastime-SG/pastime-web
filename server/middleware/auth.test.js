const mockSdk = { currentUser: { show: jest.fn() } };
jest.mock('../api-util/sdk', () => ({
  getSdk: () => mockSdk,
  handleError: (res, e) => res.status(e.status || 500).json({ status: e.status || 500 }),
}));

const auth = require('./auth');

const createResponse = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('middleware.auth', () => {
  beforeEach(() => jest.clearAllMocks());

  it('adds the signed-in user to the request', async () => {
    mockSdk.currentUser.show.mockResolvedValue({
      data: {
        data: {
          id: { uuid: 'user-1' },
          attributes: {
            profile: { firstName: 'Pat', lastName: 'Doe', publicData: { userType: 'provider' } },
          },
        },
      },
    });
    const req = {};
    const next = jest.fn();
    await auth(req, createResponse(), next);

    expect(next).toHaveBeenCalled();
    expect(req.currentUser.id.uuid).toBe('user-1');
    expect(req).toMatchObject({
      tokenUserId: 'user-1',
      userType: 'provider',
      displayName: 'Pat Doe',
    });
  });

  it("responds with the error and doesn't continue if the user isn't signed in", async () => {
    const error = new Error('Unauthorized');
    error.status = 401;
    mockSdk.currentUser.show.mockRejectedValue(error);
    const res = createResponse();
    const next = jest.fn();
    await auth({}, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
