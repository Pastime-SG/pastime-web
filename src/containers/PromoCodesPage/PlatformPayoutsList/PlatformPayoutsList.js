import React from 'react';
import classNames from 'classnames';

import { FormattedMessage, useIntl } from '../../../util/reactIntl';
import { formatMoney } from '../../../util/currency';
import { types as sdkTypes } from '../../../util/sdkLoader';

import css from './PlatformPayoutsList.module.css';

const { Money } = sdkTypes;

// Status text of a payout (see server/services/platformPayouts)
const getStatusId = payout =>
  payout.status === 'paid'
    ? 'PlatformPayoutsList.status.paid'
    : payout.lastError === 'platform-balance-too-low'
    ? 'PlatformPayoutsList.status.balanceTooLow'
    : payout.lastError
    ? 'PlatformPayoutsList.status.retrying'
    : 'PlatformPayoutsList.status.waitingForFunds';

/**
 * Admins: the payouts Pastime pays to studios (bookings with credits or Pastime's promo codes
 * above the commission, and free bookings). Read only.
 *
 * @component
 * @param {Object} props
 * @param {Array<Object>} props.payouts From GET /api/admin/platform-payouts
 * @returns {JSX.Element}
 */
const PlatformPayoutsList = props => {
  const intl = useIntl();
  const { payouts } = props;
  const money = (amount, currency) =>
    formatMoney(intl, new Money(amount || 0, (currency || '').toUpperCase()));
  const date = value =>
    value
      ? intl.formatDate(new Date(value), { day: 'numeric', month: 'short', year: 'numeric' })
      : '';

  return (
    <ul className={css.list}>
      {payouts.map(payout => {
        const isPaid = payout.status === 'paid';
        const isBalanceLow = payout.lastError === 'platform-balance-too-low';
        return (
          <li key={payout.transactionId} className={css.row}>
            <div className={css.details}>
              <span className={css.amount}>{money(payout.payoutAmount, payout.currency)}</span>
              <span className={css.meta}>
                <FormattedMessage
                  id="PlatformPayoutsList.details"
                  values={{
                    date: date(payout.createdAt),
                    reason: payout.reason,
                    bookingId: (payout.transactionId || '').slice(0, 8),
                  }}
                />
              </span>
              {payout.platformAmount != null ? (
                <span className={css.meta}>
                  <FormattedMessage
                    id="PlatformPayoutsList.pastimePart"
                    values={{ amount: money(payout.platformAmount, payout.currency) }}
                  />
                </span>
              ) : null}
            </div>
            <span
              className={classNames(css.status, {
                [css.statusPaid]: isPaid,
                [css.statusWarning]: isBalanceLow,
              })}
            >
              <FormattedMessage
                id={getStatusId(payout)}
                values={{ date: date(isPaid ? payout.paidAt : payout.availableOn) }}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
};

export default PlatformPayoutsList;
