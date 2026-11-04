import React from 'react';
import { Form as FinalForm } from 'react-final-form';

import { FormattedMessage, useIntl } from '../../../util/reactIntl';
import { Form, FieldTextInput, Heading, PrimaryButton } from '../../../components';

import css from './FreeBookingForm.module.css';

/**
 * Booking request form when the customer pays nothing (credits or discounts cover the whole
 * price): no card details. The app's server makes the booking without a Stripe payment (see
 * server/services/commission getPaymentPlan).
 *
 * @component
 * @param {Object} props
 * @param {Function} props.onSubmit Called with { message, formValues: {} } like StripePaymentForm
 * @param {boolean} props.inProgress
 * @param {boolean} [props.disabled] E.g. while the price is updated
 * @param {string} props.providerDisplayName
 * @param {boolean} props.showInitialMessageInput
 * @param {Object} [props.initiateOrderError]
 * @returns {JSX.Element}
 */
const FreeBookingForm = props => {
  const intl = useIntl();
  const {
    onSubmit,
    inProgress,
    disabled,
    providerDisplayName,
    showInitialMessageInput,
    initiateOrderError,
  } = props;

  const messageLabel = intl.formatMessage(
    { id: 'StripePaymentForm.messageLabel' },
    { messageOptionalText: intl.formatMessage({ id: 'StripePaymentForm.messageOptionalText' }) }
  );
  const messagePlaceholder = intl.formatMessage(
    { id: 'StripePaymentForm.messagePlaceholder' },
    { name: providerDisplayName }
  );

  return (
    <FinalForm
      onSubmit={values =>
        onSubmit({
          message: values.initialMessage ? values.initialMessage.trim() : null,
          formValues: {},
        })
      }
      render={({ handleSubmit }) => (
        <Form className={css.root} onSubmit={handleSubmit}>
          <Heading as="h3" rootClassName={css.heading}>
            <FormattedMessage id="FreeBookingForm.title" />
          </Heading>
          <p className={css.info}>
            <FormattedMessage id="FreeBookingForm.info" values={{ name: providerDisplayName }} />
          </p>
          {showInitialMessageInput ? (
            <FieldTextInput
              type="textarea"
              id="FreeBookingForm-message"
              name="initialMessage"
              label={messageLabel}
              placeholder={messagePlaceholder}
              className={css.message}
            />
          ) : null}
          {initiateOrderError ? (
            <p className={css.error}>
              <FormattedMessage id="FreeBookingForm.error" />
            </p>
          ) : null}
          <PrimaryButton
            className={css.submitButton}
            type="submit"
            inProgress={inProgress}
            disabled={inProgress || disabled}
          >
            <FormattedMessage id="FreeBookingForm.submit" />
          </PrimaryButton>
        </Form>
      )}
    />
  );
};

export default FreeBookingForm;
