const mockLoyalty = {
  confirmSpentCredits: jest.fn(),
  getLoyaltyAccount: jest.fn(),
  releaseSpentCredits: jest.fn(),
  spendCredits: jest.fn(),
};
jest.mock('./index', () => ({
  confirmSpentCredits: (...args) => mockLoyalty.confirmSpentCredits(...args),
  getLoyaltyAccount: (...args) => mockLoyalty.getLoyaltyAccount(...args),
  releaseSpentCredits: (...args) => mockLoyalty.releaseSpentCredits(...args),
  spendCredits: (...args) => mockLoyalty.spendCredits(...args),
}));
jest.mock('../../log', () => ({ error: jest.fn() }));

const { types } = require('sharetribe-flex-sdk');
const { getBookingLoyalty, getLoyaltyProtectedData, withLoyaltyCredits } = require('./checkout');

const lineItems = [
  { code: 'line-item/loyalty-credit', unitPrice: new types.Money(-300, 'SGD'), quantity: 1 },
];
const loyalty = { customerId: 'customer-1', redemptionId: 'r1', balance: 500, currency: 'SGD' };

describe('loyalty credits at checkout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoyalty.spendCredits.mockResolvedValue();
    mockLoyalty.releaseSpentCredits.mockResolvedValue();
    mockLoyalty.confirmSpentCredits.mockResolvedValue();
  });

  it('makes no calls unless the customer opts in', async () => {
    const sdk = { currentUser: { show: jest.fn() } };
    const params = { sdk, transitionName: 'transition/request-payment' };
    expect(await getBookingLoyalty({ ...params, orderData: {} })).toBe(null);
    expect(await getBookingLoyalty({ ...params, orderData: { useCredits: 'true' } })).toBe(null);
    expect(sdk.currentUser.show).not.toHaveBeenCalled();
  });

  it('looks up the signed-in customer, not anyone the client names', async () => {
    const sdk = {
      currentUser: {
        show: jest.fn().mockResolvedValue({ data: { data: { id: { uuid: 'customer-1' } } } }),
      },
    };
    mockLoyalty.getLoyaltyAccount.mockResolvedValue({ creditBalance: 500, currency: 'SGD' });
    const result = await getBookingLoyalty({
      sdk,
      orderData: { useCredits: true, customerId: 'someone-else' },
      transitionName: 'transition/request-payment',
    });
    expect(mockLoyalty.getLoyaltyAccount).toHaveBeenCalledWith('customer-1');
    expect(result).toMatchObject({ customerId: 'customer-1', balance: 500, currency: 'SGD' });
  });

  it('takes the credits before the request and links them to the booking', async () => {
    const makeRequest = jest.fn().mockResolvedValue({ data: { data: { id: { uuid: 'tx-1' } } } });
    await withLoyaltyCredits({ loyalty, lineItems, isSpeculative: false }, makeRequest);
    expect(mockLoyalty.spendCredits).toHaveBeenCalledWith({
      customerId: 'customer-1',
      redemptionId: 'r1',
      amount: 300,
      currency: 'SGD',
    });
    expect(mockLoyalty.confirmSpentCredits).toHaveBeenCalledWith('customer-1', 'r1', 'tx-1');
    expect(getLoyaltyProtectedData(loyalty, lineItems)).toEqual({
      loyalty: { customerId: 'customer-1', redemptionId: 'r1', credits: 300, currency: 'SGD' },
    });
  });

  it('gives the credits back if the request fails, and takes none for previews', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('failed'));
    await expect(
      withLoyaltyCredits({ loyalty, lineItems, isSpeculative: false }, failing)
    ).rejects.toThrow('failed');
    expect(mockLoyalty.releaseSpentCredits).toHaveBeenCalledWith('customer-1', 'r1');

    jest.clearAllMocks();
    await withLoyaltyCredits({ loyalty, lineItems, isSpeculative: true }, jest.fn());
    expect(mockLoyalty.spendCredits).not.toHaveBeenCalled();
  });
});
