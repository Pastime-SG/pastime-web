import React from 'react';
import { Form as FinalForm } from 'react-final-form';
import { FieldArray } from 'react-final-form-arrays';
import arrayMutators from 'final-form-arrays';
import classNames from 'classnames';

// Import configs and util modules
import { FormattedMessage, useIntl } from '../../../../util/reactIntl';
import * as validators from '../../../../util/validators';
import {
  COMPARISONS,
  COMPARISON_MORE_THAN,
  MAX_CANCELLATION_RULES,
  UNITS,
  UNIT_HOURS,
} from '../../../../util/policies';

// Import shared components
import {
  Button,
  FieldRadioButton,
  FieldSelect,
  FieldTextInput,
  Form,
  H4,
  InlineTextButton,
} from '../../../../components';

// Import modules from this directory
import css from './EditListingPoliciesForm.module.css';

export const RESCHEDULE_ALLOWED = 'yes';
export const RESCHEDULE_NOT_ALLOWED = 'no';

const initialRuleValues = {
  heading: '',
  comparison: COMPARISON_MORE_THAN,
  amount: '',
  unit: UNIT_HOURS,
  refundPercentage: '',
};

// A whole number between min and max (inclusive). Form values of number inputs are strings.
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

// Empty (no cutoff) or a whole number of at least 1
const optionalWholeNumberAtLeastOne = message => value =>
  value === '' || value == null ? undefined : wholeNumberBetween(message, 1)(value);

const UnitSelect = props => {
  const intl = useIntl();
  const { id, name, label, className } = props;
  return (
    <FieldSelect className={className} id={id} name={name} label={label}>
      {UNITS.map(unit => (
        <option key={unit} value={unit}>
          {intl.formatMessage({ id: `EditListingPoliciesForm.unit.${unit}` })}
        </option>
      ))}
    </FieldSelect>
  );
};

/**
 * Up to MAX_CANCELLATION_RULES cancellation rules: heading, "more than" / "less than", an amount of
 * hours or days before the booking starts, and the refund percentage.
 */
const CancellationRules = props => {
  const intl = useIntl();
  const { formId } = props;
  const amountMessage = intl.formatMessage({ id: 'EditListingPoliciesForm.ruleAmountInvalid' });
  const refundMessage = intl.formatMessage({ id: 'EditListingPoliciesForm.ruleRefundInvalid' });
  const headingRequired = validators.required(
    intl.formatMessage({ id: 'EditListingPoliciesForm.ruleHeadingRequired' })
  );

  return (
    <FieldArray name="cancellationRules">
      {({ fields }) => (
        <div className={css.rules}>
          {fields.length === 0 ? (
            <p className={css.note}>
              <FormattedMessage id="EditListingPoliciesForm.noRules" />
            </p>
          ) : null}

          {fields.map((name, index) => {
            const fieldId = field => `${formId}.${name}.${field}`;
            return (
              <fieldset className={css.rule} key={name}>
                <div className={css.ruleHeader}>
                  <legend className={css.ruleLegend}>
                    <FormattedMessage
                      id="EditListingPoliciesForm.ruleLegend"
                      values={{ number: index + 1 }}
                    />
                  </legend>
                  <InlineTextButton
                    type="button"
                    className={css.removeRule}
                    onClick={() => fields.remove(index)}
                  >
                    <FormattedMessage id="EditListingPoliciesForm.removeRule" />
                  </InlineTextButton>
                </div>

                <FieldTextInput
                  className={css.field}
                  id={fieldId('heading')}
                  name={`${name}.heading`}
                  type="text"
                  label={intl.formatMessage({ id: 'EditListingPoliciesForm.ruleHeadingLabel' })}
                  placeholder={intl.formatMessage({
                    id: 'EditListingPoliciesForm.ruleHeadingPlaceholder',
                  })}
                  validate={headingRequired}
                />

                <div className={css.row}>
                  <FieldSelect
                    className={css.rowField}
                    id={fieldId('comparison')}
                    name={`${name}.comparison`}
                    label={intl.formatMessage({
                      id: 'EditListingPoliciesForm.ruleComparisonLabel',
                    })}
                  >
                    {COMPARISONS.map(comparison => (
                      <option key={comparison} value={comparison}>
                        {intl.formatMessage({
                          id: `EditListingPoliciesForm.comparison.${comparison}`,
                        })}
                      </option>
                    ))}
                  </FieldSelect>
                  <FieldTextInput
                    className={css.rowField}
                    id={fieldId('amount')}
                    name={`${name}.amount`}
                    type="number"
                    min="0"
                    step="1"
                    label={intl.formatMessage({ id: 'EditListingPoliciesForm.ruleAmountLabel' })}
                    validate={wholeNumberBetween(amountMessage, 0)}
                  />
                  <UnitSelect
                    className={css.rowField}
                    id={fieldId('unit')}
                    name={`${name}.unit`}
                    label={intl.formatMessage({ id: 'EditListingPoliciesForm.ruleUnitLabel' })}
                  />
                </div>

                <FieldTextInput
                  className={css.field}
                  id={fieldId('refundPercentage')}
                  name={`${name}.refundPercentage`}
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  label={intl.formatMessage({ id: 'EditListingPoliciesForm.ruleRefundLabel' })}
                  validate={wholeNumberBetween(refundMessage, 0, 100)}
                />
              </fieldset>
            );
          })}

          {fields.length < MAX_CANCELLATION_RULES ? (
            <InlineTextButton
              type="button"
              className={css.addRule}
              onClick={() => fields.push(initialRuleValues)}
            >
              <FormattedMessage
                id="EditListingPoliciesForm.addRule"
                values={{ max: MAX_CANCELLATION_RULES }}
              />
            </InlineTextButton>
          ) : null}
        </div>
      )}
    </FieldArray>
  );
};

/**
 * The provider's rescheduling and cancellation policies for a booking listing.
 *
 * @component
 * @param {Object} props
 * @param {string} [props.className]
 * @param {string} props.formId
 * @param {Object} props.initialValues
 * @param {Function} props.onSubmit
 * @param {string} props.saveActionMsg Submit button text
 * @param {boolean} props.disabled
 * @param {boolean} props.ready
 * @param {boolean} props.updated
 * @param {boolean} props.updateInProgress
 * @param {Object} props.fetchErrors
 * @returns {JSX.Element}
 */
const EditListingPoliciesForm = props => (
  <FinalForm
    {...props}
    mutators={{ ...arrayMutators }}
    render={formRenderProps => {
      const intl = useIntl();
      const {
        formId = 'EditListingPoliciesForm',
        className,
        handleSubmit,
        values,
        invalid,
        pristine,
        disabled,
        ready,
        saveActionMsg,
        updated,
        updateInProgress,
        fetchErrors,
      } = formRenderProps;
      const { updateListingError, showListingsError } = fetchErrors || {};
      const allowsReschedule = values.rescheduleAllowed === RESCHEDULE_ALLOWED;
      const submitReady = (updated && pristine) || ready;
      const submitDisabled = invalid || disabled || updateInProgress;

      return (
        <Form className={classNames(css.root, className)} onSubmit={handleSubmit}>
          {updateListingError ? (
            <p className={css.error}>
              <FormattedMessage id="EditListingPoliciesForm.updateFailed" />
            </p>
          ) : null}
          {showListingsError ? (
            <p className={css.error}>
              <FormattedMessage id="EditListingPoliciesForm.showListingFailed" />
            </p>
          ) : null}

          <section className={css.section}>
            <H4 as="h2" className={css.sectionTitle}>
              <FormattedMessage id="EditListingPoliciesForm.rescheduleTitle" />
            </H4>
            <p className={css.note}>
              <FormattedMessage id="EditListingPoliciesForm.rescheduleDescription" />
            </p>
            <FieldRadioButton
              id={`${formId}.rescheduleAllowed.yes`}
              name="rescheduleAllowed"
              value={RESCHEDULE_ALLOWED}
              label={intl.formatMessage({ id: 'EditListingPoliciesForm.rescheduleAllowed' })}
            />
            <FieldRadioButton
              id={`${formId}.rescheduleAllowed.no`}
              name="rescheduleAllowed"
              value={RESCHEDULE_NOT_ALLOWED}
              label={intl.formatMessage({ id: 'EditListingPoliciesForm.rescheduleNotAllowed' })}
            />
            {allowsReschedule ? (
              <div className={css.row}>
                <FieldTextInput
                  className={css.rowField}
                  id={`${formId}.rescheduleNoticeAmount`}
                  name="rescheduleNoticeAmount"
                  type="number"
                  min="0"
                  step="1"
                  label={intl.formatMessage({
                    id: 'EditListingPoliciesForm.rescheduleNoticeLabel',
                  })}
                  validate={wholeNumberBetween(
                    intl.formatMessage({ id: 'EditListingPoliciesForm.rescheduleNoticeInvalid' }),
                    0
                  )}
                />
                <UnitSelect
                  className={css.rowField}
                  id={`${formId}.rescheduleNoticeUnit`}
                  name="rescheduleNoticeUnit"
                  label={intl.formatMessage({ id: 'EditListingPoliciesForm.ruleUnitLabel' })}
                />
              </div>
            ) : null}
          </section>

          <section className={css.section}>
            <H4 as="h2" className={css.sectionTitle}>
              <FormattedMessage id="EditListingPoliciesForm.bookingCutoffTitle" />
            </H4>
            <p className={css.note}>
              <FormattedMessage id="EditListingPoliciesForm.bookingCutoffDescription" />
            </p>
            <div className={css.row}>
              <FieldTextInput
                className={css.rowField}
                id={`${formId}.bookingCutoffAmount`}
                name="bookingCutoffAmount"
                type="number"
                min="1"
                step="1"
                label={intl.formatMessage({ id: 'EditListingPoliciesForm.bookingCutoffLabel' })}
                placeholder={intl.formatMessage({
                  id: 'EditListingPoliciesForm.bookingCutoffPlaceholder',
                })}
                validate={optionalWholeNumberAtLeastOne(
                  intl.formatMessage({ id: 'EditListingPoliciesForm.bookingCutoffInvalid' })
                )}
              />
              <UnitSelect
                className={css.rowField}
                id={`${formId}.bookingCutoffUnit`}
                name="bookingCutoffUnit"
                label={intl.formatMessage({ id: 'EditListingPoliciesForm.ruleUnitLabel' })}
              />
            </div>
          </section>

          <section className={css.section}>
            <H4 as="h2" className={css.sectionTitle}>
              <FormattedMessage id="EditListingPoliciesForm.cancellationTitle" />
            </H4>
            <ul className={css.facts}>
              <li>
                <FormattedMessage id="EditListingPoliciesForm.freeBeforeAccept" />
              </li>
              <li>
                <FormattedMessage id="EditListingPoliciesForm.rulesAfterAccept" />
              </li>
              <li>
                <FormattedMessage id="EditListingPoliciesForm.highestRefundApplies" />
              </li>
              <li>
                <FormattedMessage id="EditListingPoliciesForm.stripeFeeNonRefundable" />
              </li>
            </ul>
            <CancellationRules formId={formId} />
          </section>

          <Button
            className={css.submitButton}
            type="submit"
            inProgress={updateInProgress}
            disabled={submitDisabled}
            ready={submitReady}
          >
            {saveActionMsg}
          </Button>
        </Form>
      );
    }}
  />
);

export default EditListingPoliciesForm;
