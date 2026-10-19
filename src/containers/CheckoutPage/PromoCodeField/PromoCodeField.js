import React, { useState } from 'react';
import classNames from 'classnames';

import { FormattedMessage, useIntl } from '../../../util/reactIntl';

import { SecondaryButton } from '../../../components';

import css from './PromoCodeField.module.css';

const ERROR_MESSAGE_IDS = {
  'promo-code-invalid': 'PromoCodeField.error.invalid',
  'promo-code-expired': 'PromoCodeField.error.expired',
  'promo-code-used-up': 'PromoCodeField.error.usedUp',
};

/**
 * Promo code at checkout: the customer enters a code and applies it. The app's server checks
 * the code for the listing and adds the discount to the price breakdown.
 *
 * @component
 * @param {Object} props
 * @param {string} [props.className]
 * @param {string} [props.appliedCode] The code that is applied
 * @param {string} [props.errorCode] Why the last code couldn't be applied
 * @param {boolean} [props.disabled]
 * @param {boolean} [props.inProgress] The price is being updated for the code
 * @param {Function} props.onApply Called with the code
 * @param {Function} props.onRemove Called when the field is emptied and applied
 * @returns {JSX.Element}
 */
const PromoCodeField = props => {
  const intl = useIntl();
  const { className, appliedCode, errorCode, disabled, inProgress, onApply, onRemove } = props;
  // The applied code stays in the field: a different code replaces it, an empty field removes it
  const [value, setValue] = useState(appliedCode || '');
  const code = value.trim().toUpperCase();
  const isChanged = code !== (appliedCode || '');

  const handleSubmit = e => {
    e.preventDefault();
    if (disabled || !isChanged) {
      return;
    }
    if (code) {
      onApply(code);
    } else {
      onRemove();
    }
  };
  const errorId = errorCode ? ERROR_MESSAGE_IDS[errorCode] || 'PromoCodeField.error.invalid' : null;

  return (
    // Not a <form>: the field is next to the payment form, and forms can't be nested
    <div className={classNames(css.root, className)}>
      <label className={css.label} htmlFor="CheckoutPage.promoCode">
        <FormattedMessage id="PromoCodeField.label" />
      </label>
      <div className={css.row}>
        <input
          id="CheckoutPage.promoCode"
          className={css.input}
          type="text"
          value={value}
          autoComplete="off"
          maxLength={20}
          placeholder={intl.formatMessage({ id: 'PromoCodeField.placeholder' })}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => (e.key === 'Enter' ? handleSubmit(e) : null)}
          aria-invalid={!!errorId}
          aria-describedby={errorId ? 'CheckoutPage.promoCodeError' : undefined}
        />
        <SecondaryButton
          className={css.applyButton}
          type="button"
          inProgress={inProgress}
          disabled={disabled || !isChanged}
          onClick={handleSubmit}
        >
          <FormattedMessage id="PromoCodeField.apply" />
        </SecondaryButton>
      </div>
      {errorId ? (
        <p id="CheckoutPage.promoCodeError" className={css.error} role="alert">
          <FormattedMessage id={errorId} />
        </p>
      ) : null}
    </div>
  );
};

export default PromoCodeField;
