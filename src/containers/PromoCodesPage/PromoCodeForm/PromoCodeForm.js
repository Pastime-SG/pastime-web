import React from 'react';
import { Form as FinalForm } from 'react-final-form';
import classNames from 'classnames';

// Import configs and util modules
import appSettings from '../../../config/settings';
import { FormattedMessage, useIntl } from '../../../util/reactIntl';
import * as validators from '../../../util/validators';

// Import shared components
import {
  FieldCurrencyInput,
  FieldRadioButton,
  FieldTextInput,
  Form,
  PrimaryButton,
} from '../../../components';

import css from './PromoCodeForm.module.css';

export const DISCOUNT_PERCENTAGE = 'percentage';
export const DISCOUNT_FIXED = 'fixed';

// Same rule as the server: 3-20 letters, numbers, dashes or underscores
const CODE_PATTERN = /^[A-Za-z0-9_-]{3,20}$/;

const wholeNumberBetween = (message, min, max) => value => {
  const number = Number(value);
  const isValid =
    value !== '' &&
    value != null &&
    Number.isInteger(number) &&
    number >= min &&
    (max == null || number <= max);
  return isValid ? undefined : message;
};

const optional = validator => value => (value === '' || value == null ? undefined : validator(value));

/**
 * Form for creating or editing a promo code. The code can't be changed after it's created, and
 * the discount can't be changed once the code has been used.
 *
 * @component
 * @param {Object} props
 * @param {string} [props.className]
 * @param {string} props.formId
 * @param {Object} props.initialValues
 * @param {Function} props.onSubmit
 * @param {boolean} props.isEdit
 * @param {boolean} props.isUsed The code has been used: the discount can't be changed
 * @param {string} props.marketplaceCurrency
 * @param {boolean} props.inProgress
 * @param {string} [props.errorMessage]
 * @returns {JSX.Element}
 */
const PromoCodeForm = props => (
  <FinalForm
    {...props}
    render={formRenderProps => {
      const intl = useIntl();
      const {
        className,
        formId,
        handleSubmit,
        values,
        invalid,
        isEdit,
        isUsed,
        marketplaceCurrency,
        inProgress,
        errorMessage,
      } = formRenderProps;
      const isPercentage = values.discountType === DISCOUNT_PERCENTAGE;
      const discountLocked = isEdit && isUsed;

      return (
        <Form className={classNames(css.root, className)} onSubmit={handleSubmit}>
          <FieldTextInput
            className={css.field}
            id={`${formId}.code`}
            name="code"
            type="text"
            label={intl.formatMessage({ id: 'PromoCodeForm.codeLabel' })}
            placeholder={intl.formatMessage({ id: 'PromoCodeForm.codePlaceholder' })}
            disabled={isEdit}
            format={value => (value ? value.toUpperCase() : value)}
            validate={validators.composeValidators(
              validators.required(intl.formatMessage({ id: 'PromoCodeForm.codeRequired' })),
              value =>
                CODE_PATTERN.test((value || '').trim())
                  ? undefined
                  : intl.formatMessage({ id: 'PromoCodeForm.codeInvalid' })
            )}
          />
          {isEdit ? (
            <p className={css.note}>
              <FormattedMessage id="PromoCodeForm.codeLocked" />
            </p>
          ) : null}

          <fieldset className={css.fieldset} disabled={discountLocked}>
            <legend className={css.legend}>
              <FormattedMessage id="PromoCodeForm.discountLabel" />
            </legend>
            <div className={css.radios}>
              <FieldRadioButton
                id={`${formId}.discountType.percentage`}
                name="discountType"
                value={DISCOUNT_PERCENTAGE}
                label={intl.formatMessage({ id: 'PromoCodeForm.discountPercentage' })}
              />
              <FieldRadioButton
                id={`${formId}.discountType.fixed`}
                name="discountType"
                value={DISCOUNT_FIXED}
                label={intl.formatMessage({ id: 'PromoCodeForm.discountFixed' })}
              />
            </div>
            {isPercentage ? (
              <FieldTextInput
                key="percentage"
                className={css.field}
                id={`${formId}.percentage`}
                name="percentage"
                type="number"
                min="1"
                max="100"
                step="1"
                label={intl.formatMessage({ id: 'PromoCodeForm.percentageLabel' })}
                validate={wholeNumberBetween(
                  intl.formatMessage({ id: 'PromoCodeForm.percentageInvalid' }),
                  1,
                  100
                )}
              />
            ) : (
              <FieldCurrencyInput
                key="amount"
                className={css.field}
                id={`${formId}.amount`}
                name="amount"
                label={intl.formatMessage({ id: 'PromoCodeForm.amountLabel' })}
                currencyConfig={appSettings.getCurrencyFormatting(marketplaceCurrency)}
                validate={validators.composeValidators(
                  validators.required(intl.formatMessage({ id: 'PromoCodeForm.amountRequired' })),
                  validators.moneySubUnitAmountAtLeast(
                    intl.formatMessage({ id: 'PromoCodeForm.amountRequired' }),
                    1
                  )
                )}
              />
            )}
            {discountLocked ? (
              <p className={css.note}>
                <FormattedMessage id="PromoCodeForm.discountLocked" />
              </p>
            ) : null}
          </fieldset>

          <div className={css.row}>
            <FieldTextInput
              className={css.rowField}
              id={`${formId}.maxUses`}
              name="maxUses"
              type="number"
              min="1"
              step="1"
              label={intl.formatMessage({ id: 'PromoCodeForm.maxUsesLabel' })}
              placeholder={intl.formatMessage({ id: 'PromoCodeForm.maxUsesPlaceholder' })}
              validate={optional(
                wholeNumberBetween(intl.formatMessage({ id: 'PromoCodeForm.maxUsesInvalid' }), 1)
              )}
            />
            <FieldTextInput
              className={css.rowField}
              id={`${formId}.expiresOn`}
              name="expiresOn"
              type="date"
              label={intl.formatMessage({ id: 'PromoCodeForm.expiresOnLabel' })}
            />
          </div>
          <p className={css.note}>
            <FormattedMessage id="PromoCodeForm.appliesTo" />
          </p>

          {errorMessage ? (
            <p className={css.error} role="alert">
              {errorMessage}
            </p>
          ) : null}

          <PrimaryButton
            className={css.submitButton}
            type="submit"
            inProgress={inProgress}
            disabled={invalid || inProgress}
          >
            <FormattedMessage id={isEdit ? 'PromoCodeForm.saveChanges' : 'PromoCodeForm.create'} />
          </PrimaryButton>
        </Form>
      );
    }}
  />
);

export default PromoCodeForm;
