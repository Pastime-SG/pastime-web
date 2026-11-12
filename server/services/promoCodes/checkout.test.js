const mockPromoCodes = {
  confirmPromoCodeUse: jest.fn(),
  findPromoCodeForBooking: jest.fn(),
  releasePromoCodeUse: jest.fn(),
  reservePromoCodeUse: jest.fn(),
};
jest.mock('./index', () => ({
  confirmPromoCodeUse: (...args) => mockPromoCodes.confirmPromoCodeUse(...args),
  findPromoCodeForBooking: (...args) => mockPromoCodes.findPromoCodeForBooking(...args),
  releasePromoCodeUse: (...args) => mockPromoCodes.releasePromoCodeUse(...args),
  reservePromoCodeUse: (...args) => mockPromoCodes.reservePromoCodeUse(...args),
}));
jest.mock('../../log', () => ({ error: jest.fn() }));

const { getBookingPromoCode, getPromoCodeProtectedData, withPromoCodeUse } = require('./checkout');

const promoCode = { id: 'merchant_p_SUMMER10', code: 'SUMMER10', createdBy: 'merchant' };
const lineItems = [
  { code: 'line-item/promo-discount', unitPrice: { amount: -500, currency: 'SGD' } },
];

describe('promo codes at checkout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPromoCodes.reservePromoCodeUse.mockResolvedValue();
    mockPromoCodes.confirmPromoCodeUse.mockResolvedValue();
    mockPromoCodes.releasePromoCodeUse.mockResolvedValue();
  });

  it('only takes a code on booking requests', async () => {
    mockPromoCodes.findPromoCodeForBooking.mockResolvedValue(promoCode);
    const orderData = { promoCode: 'summer10' };
    const processName = 'default-booking/release-1';
    const request = 'transition/request-payment';
    await getBookingPromoCode({
      orderData,
      providerId: 'p',
      transitionName: 'transition/accept',
      processName,
    });
    // Only the booking process takes codes
    await getBookingPromoCode({
      orderData,
      providerId: 'p',
      transitionName: request,
      processName: 'default-purchase/release-1',
    });
    expect(mockPromoCodes.findPromoCodeForBooking).not.toHaveBeenCalled();
    await getBookingPromoCode({ orderData, providerId: 'p', transitionName: request, processName });
    expect(mockPromoCodes.findPromoCodeForBooking).toHaveBeenCalledWith({
      code: 'summer10',
      providerId: 'p',
    });
  });

  it('stores a copy of the applied code with the discount', () => {
    expect(getPromoCodeProtectedData({ ...promoCode, redemptionId: 'r1' }, lineItems)).toEqual({
      promoCode: {
        // Which use of which code: to give it back if the booking doesn't go ahead
        id: 'merchant_p_SUMMER10',
        redemptionId: 'r1',
        code: 'SUMMER10',
        createdBy: 'merchant',
        discount: 500,
        currency: 'SGD',
      },
    });
    expect(getPromoCodeProtectedData(null, lineItems)).toEqual({});
  });

  it('reserves a use before the booking and confirms it with the transaction', async () => {
    const response = { data: { data: { id: { uuid: 'tx-1' } } } };
    const result = await withPromoCodeUse(
      {
        promoCode: { ...promoCode, redemptionId: 'r1' },
        lineItems,
        isSpeculative: false,
        details: {},
      },
      () => Promise.resolve(response)
    );
    expect(result).toBe(response);
    expect(mockPromoCodes.reservePromoCodeUse).toHaveBeenCalled();
    const [, redemptionId, transactionId] = mockPromoCodes.confirmPromoCodeUse.mock.calls[0];
    expect(transactionId).toBe('tx-1');
    expect(redemptionId).toBe(mockPromoCodes.reservePromoCodeUse.mock.calls[0][0].redemptionId);
  });

  it('gives the use back if the booking fails, and previews never count', async () => {
    await expect(
      withPromoCodeUse({ promoCode, lineItems, isSpeculative: false, details: {} }, () =>
        Promise.reject(new Error('payment failed'))
      )
    ).rejects.toThrow('payment failed');
    expect(mockPromoCodes.releasePromoCodeUse).toHaveBeenCalled();

    jest.clearAllMocks();
    await withPromoCodeUse({ promoCode, lineItems, isSpeculative: true, details: {} }, () =>
      Promise.resolve({})
    );
    expect(mockPromoCodes.reservePromoCodeUse).not.toHaveBeenCalled();
  });
});
