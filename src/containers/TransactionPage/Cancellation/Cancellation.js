import React, { useEffect, useState } from 'react';
import classNames from 'classnames';

import { FormattedMessage, useIntl } from '../../../util/reactIntl';
import { formatMoney } from '../../../util/currency';
import { types as sdkTypes } from '../../../util/sdkLoader';

import { ListingPolicies, Modal, PrimaryButton, SecondaryButton } from '../../../components';

import { formatBookingTime } from '../Reschedule/Reschedule.helpers';

import css from './Cancellation.module.css';

const { Money } = sdkTypes;

const toMoney = (amount, currency) => new Money(amount, `${currency}`.toUpperCase());

const ERROR_MESSAGE_IDS = {
  'not-cancellable': 'TransactionPage.Cancellation.error.notCancellable',
};

const getErrorMessage = (intl, error) =>
  error
    ? intl.formatMessage({
        id: ERROR_MESSAGE_IDS[error.code] || 'TransactionPage.Cancellation.error.generic',
      })
    : null;

// Calendar with a cross (24x24, stroke-based)
const CalendarX = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M16 2v4M8 2v4M3 10h18" />
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="m14 14-4 4M10 14l4 4" />
  </svg>
);

const Card = ({ title, children }) => (
  <section className={classNames(css.card, css.neutral)}>
    <div className={css.cardHeader}>
      <span className={css.cardIcon}>
        <CalendarX className={css.cardIconSvg} />
      </span>
      <h3 className={css.cardTitle}>{title}</h3>
    </div>
    {children}
  </section>
);

// Paid / non-refundable card processing fee / refund
const RefundRows = ({ intl, paid, stripeFee, refund, currency }) => (
  <dl className={css.amounts}>
    <dt className={css.amountLabel}>
      <FormattedMessage id="TransactionPage.Cancellation.paid" />
    </dt>
    <dd className={css.amountValue}>{formatMoney(intl, toMoney(paid, currency))}</dd>
    {stripeFee ? (
      <>
        <dt className={css.amountLabel}>
          <FormattedMessage id="TransactionPage.Cancellation.fee" />
        </dt>
        <dd className={css.amountValue}>−{formatMoney(intl, toMoney(stripeFee, currency))}</dd>
      </>
    ) : null}
    <dt className={classNames(css.amountLabel, css.total)}>
      <FormattedMessage id="TransactionPage.Cancellation.refund" />
    </dt>
    <dd className={classNames(css.amountValue, css.total)}>
      {formatMoney(intl, toMoney(refund, currency))}
    </dd>
  </dl>
);

// The policies of the booking, with the rule that applies now in bold
const BookingPolicies = ({ policies, applicableRule }) => (
  <div className={css.policies}>
    <h4 className={css.policiesTitle}>
      <FormattedMessage id="TransactionPage.Cancellation.policiesTitle" />
    </h4>
    <ListingPolicies
      policies={policies}
      showReschedule={false}
      highlightedRuleHeading={applicableRule?.heading}
    />
  </div>
);

/**
 * Customer cancellations on the transaction page (providers can't cancel bookings for now):
 *
 * - Before the booking is accepted: cancel the request for free (card authorization released)
 * - After it's accepted: cancel by the cancellation rule that applies now, from the policies
 *   copied to the booking. The refund (payment minus the non-refundable card processing fee) is
 *   shown before confirming. The policies are listed under the button.
 * - After the cancellation: the refund (customer) or the payout (provider)
 *
 * @component
 * @param {Object} props
 * @param {Object|null} props.info Result of getCancellationInfo
 * @param {'customer'|'provider'} props.transactionRole
 * @param {string} props.otherUserDisplayName
 * @param {string} props.timeZone Listing's time zone
 * @param {Function} props.onCancelRequest Cancels the booking request (before acceptance)
 * @param {boolean} props.cancelRequestInProgress
 * @param {Object|null} props.cancelRequestError
 * @param {Function} props.onFetchCancelPreview
 * @param {Object|null} props.cancelPreview See server/api/cancel/cancel.js
 * @param {boolean} props.cancelPreviewInProgress
 * @param {Object|null} props.cancelPreviewError
 * @param {Function} props.onCancel Cancels the accepted booking
 * @param {boolean} props.cancelInProgress
 * @param {Object|null} props.cancelError
 * @param {Function} props.onManageDisableScrolling
 * @returns {JSX.Element|null}
 */
const Cancellation = props => {
  const intl = useIntl();
  const [modal, setModal] = useState(null);
  const {
    info,
    transactionRole,
    otherUserDisplayName,
    timeZone,
    onCancelRequest,
    cancelRequestInProgress,
    cancelRequestError,
    onFetchCancelPreview,
    cancelPreview,
    cancelPreviewInProgress,
    cancelPreviewError,
    onCancel,
    cancelInProgress,
    cancelError,
    onManageDisableScrolling,
  } = props;

  // The refund is calculated by the server from the payment, only when the customer is about to
  // cancel. A failure is shown from cancelPreviewError.
  useEffect(() => {
    if (modal === 'cancel') {
      onFetchCancelPreview().catch(() => {});
    }
  }, [modal]);

  if (!info) {
    return null;
  }

  const isCustomer = transactionRole === 'customer';
  const names = { otherUserDisplayName };
  const bookingTime = formatBookingTime(intl, info.booking.start, info.booking.end, timeZone);
  const closeModal = () => setModal(null);

  // After the cancellation
  if (info.isCancelledRequest) {
    return (
      <Card title={intl.formatMessage({ id: 'TransactionPage.Cancellation.requestCancelledTitle' })}>
        <p className={css.note}>
          <FormattedMessage
            id={
              isCustomer
                ? 'TransactionPage.Cancellation.requestCancelledCustomer'
                : 'TransactionPage.Cancellation.requestCancelledProvider'
            }
            values={names}
          />
        </p>
      </Card>
    );
  }

  if (info.isCancelled) {
    const { cancellation } = info;
    const hasRefund = cancellation?.refund > 0;
    const rule = {
      ruleHeading: cancellation?.ruleHeading,
      refundPercentage: cancellation?.refundPercentage,
    };
    return (
      <Card title={intl.formatMessage({ id: 'TransactionPage.Cancellation.cancelledTitle' })}>
        {isCustomer ? (
          <>
            {cancellation?.ruleHeading ? (
              <p className={css.note}>
                <FormattedMessage id="TransactionPage.Cancellation.appliedRule" values={rule} />
              </p>
            ) : null}
            {hasRefund ? (
              <>
                <RefundRows intl={intl} {...cancellation} />
                <p className={css.note}>
                  <FormattedMessage id="TransactionPage.Cancellation.refundTiming" />
                </p>
              </>
            ) : (
              <p className={css.note}>
                <FormattedMessage id="TransactionPage.Cancellation.noRefund" />
              </p>
            )}
          </>
        ) : (
          <>
            <p className={css.note}>
              <FormattedMessage
                id="TransactionPage.Cancellation.cancelledProvider"
                values={{ ...names, time: bookingTime }}
              />
            </p>
            {cancellation?.providerPayout != null ? (
              <p className={css.note}>
                <FormattedMessage
                  id={`TransactionPage.Cancellation.providerPayout.${cancellation.payoutStatus}`}
                  values={{
                    ...rule,
                    payout: formatMoney(
                      intl,
                      toMoney(cancellation.providerPayout, cancellation.currency)
                    ),
                    date: cancellation.payoutAvailableOn
                      ? intl.formatDate(cancellation.payoutAvailableOn, {
                          month: 'short',
                          day: 'numeric',
                        })
                      : '',
                  }}
                />
              </p>
            ) : null}
          </>
        )}
      </Card>
    );
  }

  // Before the booking is accepted: free
  if (info.canCancelRequest) {
    return (
      <>
        <Card title={intl.formatMessage({ id: 'TransactionPage.Cancellation.cancelRequestTitle' })}>
          <p className={css.note}>
            <FormattedMessage id="TransactionPage.Cancellation.cancelRequestDescription" />
          </p>
          <SecondaryButton
            className={css.secondaryButton}
            type="button"
            onClick={() => setModal('cancelRequest')}
          >
            <FormattedMessage id="TransactionPage.Cancellation.cancelRequestButton" />
          </SecondaryButton>
        </Card>
        <Modal
          id="CancelRequestModal"
          containerClassName={css.modalContainer}
          isOpen={modal === 'cancelRequest'}
          onClose={closeModal}
          onManageDisableScrolling={onManageDisableScrolling}
          usePortal
        >
          <h2 className={css.modalTitle}>
            <FormattedMessage id="TransactionPage.Cancellation.cancelRequestModalTitle" />
          </h2>
          <p className={css.modalDescription}>
            <FormattedMessage
              id="TransactionPage.Cancellation.cancelRequestModalDescription"
              values={names}
            />
          </p>
          {cancelRequestError ? (
            <p className={css.error} role="alert">
              {getErrorMessage(intl, cancelRequestError)}
            </p>
          ) : null}
          <div className={css.modalActions}>
            <PrimaryButton
              className={css.dangerButton}
              type="button"
              inProgress={cancelRequestInProgress}
              disabled={cancelRequestInProgress}
              onClick={() =>
                onCancelRequest()
                  .then(closeModal)
                  .catch(() => {})
              }
            >
              <FormattedMessage id="TransactionPage.Cancellation.cancelRequestConfirm" />
            </PrimaryButton>
            <SecondaryButton
              className={css.secondaryButton}
              type="button"
              disabled={cancelRequestInProgress}
              onClick={closeModal}
            >
              <FormattedMessage id="TransactionPage.Cancellation.keepRequest" />
            </SecondaryButton>
          </div>
        </Modal>
      </>
    );
  }

  // After the booking is accepted: by the policies copied to the booking
  if (info.isAccepted) {
    const { applicableRule, policies } = info;
    const previewError = getErrorMessage(intl, cancelPreviewError);
    const isFree = cancelPreview && cancelPreview.refund === 0;
    return (
      <>
        <Card title={intl.formatMessage({ id: 'TransactionPage.Cancellation.cancelTitle' })}>
          {info.canCancel ? (
            <>
              <p className={css.note}>
                <FormattedMessage
                  id="TransactionPage.Cancellation.cancelDescription"
                  values={{
                    ruleHeading: applicableRule.heading,
                    refundPercentage: applicableRule.refundPercentage,
                  }}
                />
              </p>
              <SecondaryButton
                className={css.secondaryButton}
                type="button"
                onClick={() => setModal('cancel')}
              >
                <FormattedMessage id="TransactionPage.Cancellation.cancelButton" />
              </SecondaryButton>
            </>
          ) : (
            <p className={css.note}>
              <FormattedMessage id="TransactionPage.Cancellation.notCancellable" />
            </p>
          )}
          <BookingPolicies policies={policies} applicableRule={applicableRule} />
        </Card>
        <Modal
          id="CancelBookingModal"
          containerClassName={css.modalContainer}
          isOpen={modal === 'cancel'}
          onClose={closeModal}
          onManageDisableScrolling={onManageDisableScrolling}
          usePortal
        >
          <h2 className={css.modalTitle}>
            <FormattedMessage id="TransactionPage.Cancellation.cancelModalTitle" />
          </h2>
          <p className={css.modalDescription}>
            <FormattedMessage
              id="TransactionPage.Cancellation.cancelModalDescription"
              values={{ ...names, time: bookingTime }}
            />
          </p>

          {cancelPreviewInProgress ? (
            <p className={css.note}>
              <FormattedMessage id="TransactionPage.Cancellation.loadingRefund" />
            </p>
          ) : cancelPreview ? (
            <>
              <p className={css.ruleSummary}>
                <FormattedMessage
                  id="TransactionPage.Cancellation.appliedRule"
                  values={{
                    ruleHeading: cancelPreview.ruleHeading,
                    refundPercentage: cancelPreview.refundPercentage,
                  }}
                />
              </p>
              {isFree ? (
                <p className={css.note}>
                  <FormattedMessage id="TransactionPage.Cancellation.noRefund" />
                </p>
              ) : (
                <RefundRows intl={intl} {...cancelPreview} />
              )}
            </>
          ) : null}

          {previewError || cancelError ? (
            <p className={css.error} role="alert">
              {previewError || getErrorMessage(intl, cancelError)}
            </p>
          ) : null}

          {!isFree ? (
            <p className={css.note}>
              <FormattedMessage id="TransactionPage.Cancellation.cancelModalNote" />
            </p>
          ) : null}

          <div className={css.modalActions}>
            <PrimaryButton
              className={css.dangerButton}
              type="button"
              inProgress={cancelInProgress}
              disabled={!cancelPreview || cancelPreviewInProgress || cancelInProgress}
              onClick={() =>
                onCancel()
                  .then(closeModal)
                  .catch(() => {})
              }
            >
              <FormattedMessage id="TransactionPage.Cancellation.cancelConfirm" />
            </PrimaryButton>
            <SecondaryButton
              className={css.secondaryButton}
              type="button"
              disabled={cancelInProgress}
              onClick={closeModal}
            >
              <FormattedMessage id="TransactionPage.Cancellation.keepBooking" />
            </SecondaryButton>
          </div>
        </Modal>
      </>
    );
  }

  return null;
};

export default Cancellation;
