import React from 'react';
import classNames from 'classnames';

import { FormattedMessage, useIntl } from '../../../util/reactIntl';
import { formatMoney } from '../../../util/currency';
import { types as sdkTypes } from '../../../util/sdkLoader';

import { IconSpinner } from '../../../components';

import css from './LoyaltyCreditsField.module.css';

const { Money } = sdkTypes;

/**
 * Loyalty credits at checkout: the customer chooses to use their credits (never automatic). The
 * app's server works out how much of the balance applies and adds it to the price breakdown.
 *
 * @component
 * @param {Object} props
 * @param {string} [props.className]
 * @param {number} props.balance Credit balance in minor units
 * @param {string} [props.currency]
 * @param {boolean} props.checked Whether the credits are used
 * @param {boolean} [props.disabled]
 * @param {boolean} [props.inProgress] The price is being updated
 * @param {Function} props.onToggle
 * @returns {JSX.Element}
 */
const LoyaltyCreditsField = props => {
  const intl = useIntl();
  const { className, balance, currency, checked, disabled, inProgress, onToggle } = props;
  const amount = currency ? formatMoney(intl, new Money(balance, currency)) : null;

  return (
    <div className={classNames(css.root, className)}>
      <input
        id="CheckoutPage.useCredits"
        className={css.checkbox}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
      />
      <label className={css.label} htmlFor="CheckoutPage.useCredits">
        <span className={css.title}>
          <FormattedMessage id="LoyaltyCreditsField.label" />
        </span>
        {amount ? (
          <span className={css.balance}>
            <FormattedMessage id="LoyaltyCreditsField.available" values={{ amount }} />
          </span>
        ) : null}
      </label>
      {inProgress ? <IconSpinner className={css.spinner} /> : null}
    </div>
  );
};

export default LoyaltyCreditsField;
