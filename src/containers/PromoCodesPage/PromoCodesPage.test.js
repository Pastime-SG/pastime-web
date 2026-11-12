import React from 'react';
import '@testing-library/jest-dom';

import { renderWithProviders as render, testingLibrary } from '../../util/testHelpers';
import { createCurrentUser } from '../../util/testData';

import PromoCodesPage, { getPromoCodeStatus } from './PromoCodesPage';

const { screen, userEvent, waitFor } = testingLibrary;

const DAY_MS = 24 * 60 * 60 * 1000;

const promoCode = values => ({
  id: `merchant_provider_${values.code}`,
  createdBy: 'merchant',
  discountType: 'percentage',
  percentage: 10,
  amount: null,
  currency: null,
  maxUses: null,
  usesCount: 0,
  expiresAt: null,
  active: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...values,
});

const initialState = promoCodes => ({
  PromoCodesPage: {
    promoCodes,
    fetchInProgress: false,
    fetchError: null,
    saveInProgress: false,
    saveError: null,
    actionInProgressId: null,
    actionError: null,
  },
  user: { currentUser: createCurrentUser('provider') },
});

describe('getPromoCodeStatus', () => {
  it('is active, inactive, expired or used up', () => {
    expect(getPromoCodeStatus(promoCode({ code: 'A' }))).toBe('active');
    expect(getPromoCodeStatus(promoCode({ code: 'A', active: false }))).toBe('inactive');
    expect(getPromoCodeStatus(promoCode({ code: 'A', expiresAt: Date.now() - DAY_MS }))).toBe(
      'expired'
    );
    expect(getPromoCodeStatus(promoCode({ code: 'A', maxUses: 2, usesCount: 2 }))).toBe('usedUp');
  });
});

describe('PromoCodesPage', () => {
  // The form is rendered in a modal (portal)
  beforeAll(() => {
    const portalRoot = document.createElement('div');
    portalRoot.id = 'portal-root';
    document.body.appendChild(portalRoot);
  });

  it('lists the codes with their usage, and only unused codes can be deleted', async () => {
    render(<PromoCodesPage />, {
      initialState: initialState([
        promoCode({ code: 'SUMMER10' }),
        promoCode({ code: 'USED5', maxUses: 10, usesCount: 3 }),
      ]),
    });

    await waitFor(() => expect(screen.getByText('SUMMER10')).toBeInTheDocument());
    expect(screen.getByText('USED5')).toBeInTheDocument();
    expect(screen.getAllByText('PromoCodesPage.usesWithLimit')).toHaveLength(1);
    // Delete is only offered for the unused code
    expect(screen.getAllByRole('button', { name: 'PromoCodesPage.delete' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'PromoCodesPage.deactivate' })).toHaveLength(2);
  });

  it('opens the form for a new code', async () => {
    render(<PromoCodesPage />, { initialState: initialState([]) });
    expect(screen.getByText('PromoCodesPage.empty')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'PromoCodesPage.createButton' }));
    expect(screen.getByText('PromoCodesPage.createTitle')).toBeInTheDocument();
    expect(screen.getByLabelText('PromoCodeForm.codeLabel')).toBeInTheDocument();
  });
});
