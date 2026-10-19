import React from 'react';
import '@testing-library/jest-dom';

import { renderWithProviders as render, testingLibrary } from '../../../util/testHelpers';

import Cancellation from './Cancellation';
import { getCancellationInfo } from './Cancellation.helpers';

const { screen, userEvent } = testingLibrary;

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date('2026-11-01T12:00:00.000Z');
const start = new Date('2026-11-03T12:00:00.000Z'); // 48 hours after NOW
const end = new Date('2026-11-03T13:30:00.000Z');

const policies = {
  cancellation: {
    rules: [
      { heading: 'Full', comparison: 'moreThan', amount: 48, unit: 'hours', refundPercentage: 100 },
      { heading: 'Half', comparison: 'moreThan', amount: 24, unit: 'hours', refundPercentage: 50 },
      { heading: 'None', comparison: 'lessThan', amount: 24, unit: 'hours', refundPercentage: 0 },
    ],
  },
};

const transaction = ({ lastTransition, metadata = {}, protectedData = { policies } }) => ({
  attributes: { processName: 'default-booking', lastTransition, metadata, protectedData },
  booking: { attributes: { start, end } },
});
const next = names => names.map(name => ({ attributes: { name } }));
const acceptedNext = next(['transition/customer-cancel', 'transition/customer-cancel-no-refund']);

describe('getCancellationInfo', () => {
  it('offers a free cancellation to the customer before the booking is accepted', () => {
    const info = getCancellationInfo({
      transaction: transaction({ lastTransition: 'transition/confirm-payment' }),
      transactionRole: 'customer',
      nextTransitions: next(['transition/customer-cancel-request']),
      now: NOW,
    });
    expect(info.canCancelRequest).toBe(true);
    expect(info.canCancel).toBe(false);
  });

  it('applies the cancellation rule of the policies copied to the booking', () => {
    const infoAt = hoursBefore =>
      getCancellationInfo({
        transaction: transaction({ lastTransition: 'transition/accept' }),
        transactionRole: 'customer',
        nextTransitions: acceptedNext,
        now: new Date(start.getTime() - hoursBefore * HOUR_MS),
      });
    expect(infoAt(72).applicableRule.heading).toBe('Full');
    expect(infoAt(30).applicableRule.heading).toBe('Half');
    expect(infoAt(2).applicableRule.heading).toBe('None');
  });

  it("can't cancel an accepted booking without rules", () => {
    const info = getCancellationInfo({
      transaction: transaction({ lastTransition: 'transition/accept', protectedData: {} }),
      transactionRole: 'customer',
      nextTransitions: acceptedNext,
      now: NOW,
    });
    expect(info.isAccepted).toBe(true);
    expect(info.canCancel).toBe(false);
  });

  it('does not let the provider cancel', () => {
    expect(
      getCancellationInfo({
        transaction: transaction({ lastTransition: 'transition/accept' }),
        transactionRole: 'provider',
        nextTransitions: next(['transition/complete']),
        now: NOW,
      })
    ).toBe(null);
  });
});

describe('Cancellation', () => {
  // The confirmation modals are rendered in a portal
  beforeAll(() => {
    const portalRoot = document.createElement('div');
    portalRoot.id = 'portal-root';
    document.body.appendChild(portalRoot);
  });

  const baseProps = {
    transactionRole: 'customer',
    otherUserDisplayName: 'Pat',
    timeZone: 'Etc/UTC',
    onCancelRequest: () => Promise.resolve(),
    onFetchCancelPreview: () => Promise.resolve(),
    onCancel: () => Promise.resolve(),
    onManageDisableScrolling: () => {},
  };

  it('shows the cancel button with the policy of the booking under it', () => {
    const info = getCancellationInfo({
      transaction: transaction({ lastTransition: 'transition/accept' }),
      transactionRole: 'customer',
      nextTransitions: acceptedNext,
      now: new Date(start.getTime() - 30 * HOUR_MS),
    });
    render(<Cancellation {...baseProps} info={info} />);

    expect(
      screen.getByRole('button', { name: 'TransactionPage.Cancellation.cancelButton' })
    ).toBeInTheDocument();
    expect(screen.getByText('TransactionPage.Cancellation.policiesTitle')).toBeInTheDocument();
    expect(screen.getByText('Half')).toBeInTheDocument();
  });

  it('shows the refund before confirming the cancellation', async () => {
    const info = getCancellationInfo({
      transaction: transaction({ lastTransition: 'transition/accept' }),
      transactionRole: 'customer',
      nextTransitions: acceptedNext,
      now: new Date(start.getTime() - 30 * HOUR_MS),
    });
    const cancelPreview = {
      ruleHeading: 'Half',
      refundPercentage: 50,
      currency: 'SGD',
      paid: 10500,
      stripeFee: 335,
      refund: 4915,
    };
    const onFetchCancelPreview = jest.fn(() => Promise.resolve());
    render(
      <Cancellation
        {...baseProps}
        info={info}
        cancelPreview={cancelPreview}
        onFetchCancelPreview={onFetchCancelPreview}
      />
    );

    await userEvent.click(
      screen.getByRole('button', { name: 'TransactionPage.Cancellation.cancelButton' })
    );
    expect(onFetchCancelPreview).toHaveBeenCalled();
    expect(screen.getByText('TransactionPage.Cancellation.fee')).toBeInTheDocument();
    expect(screen.getByText('TransactionPage.Cancellation.refund')).toBeInTheDocument();
  });

  it("shows the provider's payout after a cancellation", () => {
    const info = getCancellationInfo({
      transaction: transaction({
        lastTransition: 'transition/customer-cancel',
        metadata: {
          cancellation: {
            ruleHeading: 'Half',
            refundPercentage: 50,
            currency: 'SGD',
            refund: 4915,
            providerPayout: 4500,
            payoutStatus: 'pending',
            payoutAvailableOn: '2026-11-08T00:00:00.000Z',
          },
        },
      }),
      transactionRole: 'provider',
      nextTransitions: [],
      now: NOW,
    });
    render(<Cancellation {...baseProps} transactionRole="provider" info={info} />);

    expect(
      screen.getByText('TransactionPage.Cancellation.providerPayout.pending')
    ).toBeInTheDocument();
  });
});
