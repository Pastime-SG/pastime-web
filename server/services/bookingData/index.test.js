const { getProtectedDataParams } = require('./index');

describe('booking protected data', () => {
  const fake = {
    policies: { cancellation: { rules: [{ refundPercentage: 100 }] } },
    reschedule: { status: 'pending' },
    promoCode: { id: 'admin_X', redemptionId: 'r' },
    loyalty: { customerId: 'someone', redemptionId: 'r' },
  };

  it("never passes on the client's server-owned keys", () => {
    expect(
      getProtectedDataParams({ clientProtectedData: { ...fake, customerDefaultMessage: 'Hi' } })
    ).toEqual({ protectedData: { customerDefaultMessage: 'Hi' } });
    expect(getProtectedDataParams({ clientProtectedData: fake })).toEqual({});
  });

  it("uses the server's values", () => {
    const policies = { cancellation: { rules: [] } };
    expect(
      getProtectedDataParams({ clientProtectedData: fake, serverProtectedData: { policies } })
    ).toEqual({ protectedData: { policies } });
  });

  it('replaces what an inquiry stored when a booking is requested after it', () => {
    expect(getProtectedDataParams({ clientProtectedData: fake, replaceServerOwned: true })).toEqual(
      {
        protectedData: { policies: null, reschedule: null, promoCode: null, loyalty: null },
      }
    );
  });
});
