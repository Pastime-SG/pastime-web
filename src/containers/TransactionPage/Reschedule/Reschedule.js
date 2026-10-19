import React, { useEffect, useState } from 'react';
import classNames from 'classnames';

import { FormattedMessage, useIntl } from '../../../util/reactIntl';
import { getStartOf } from '../../../util/dates';

import { InlineTextButton, PrimaryButton, SecondaryButton } from '../../../components';

import RescheduleModal from './RescheduleModal';
import {
  OUTCOME_ACCEPTED,
  OUTCOME_DECLINED,
  OUTCOME_EXPIRED,
  formatBookingTime,
  getDayQueryRange,
  isTimeAvailable,
} from './Reschedule.helpers';

import css from './Reschedule.module.css';

const AVAILABILITY_CHECKING = 'checking';
const AVAILABILITY_AVAILABLE = 'available';
const AVAILABILITY_UNAVAILABLE = 'unavailable';

const ERROR_MESSAGE_IDS = {
  'time-unavailable': 'TransactionPage.Reschedule.error.timeUnavailable',
  'too-late': 'TransactionPage.Reschedule.error.tooLate',
  'already-rescheduled': 'TransactionPage.Reschedule.error.alreadyRescheduled',
};

const getErrorMessage = (intl, error) =>
  error
    ? intl.formatMessage({
        id: ERROR_MESSAGE_IDS[error.code] || 'TransactionPage.Reschedule.error.generic',
      })
    : null;

// Calendar icons (24x24, stroke-based) for the cards. The calendar outline is shared.
const IconBase = ({ className, children }) => (
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
    {children}
  </svg>
);

const CalendarOutline = () => (
  <>
    <path d="M16 2v4M8 2v4M3 10h18" />
    <rect x="3" y="4" width="18" height="18" rx="2" />
  </>
);

const CalendarClock = ({ className }) => (
  <IconBase className={className}>
    <path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5" />
    <path d="M16 2v4M8 2v4M3 10h5" />
    <circle cx="16" cy="16" r="6" />
    <path d="M16 14v2.2l1.6 1" />
  </IconBase>
);

const CalendarCheck = ({ className }) => (
  <IconBase className={className}>
    <CalendarOutline />
    <path d="m9 16 2 2 4-4" />
  </IconBase>
);

const CalendarX = ({ className }) => (
  <IconBase className={className}>
    <CalendarOutline />
    <path d="m14 14-4 4M10 14l4 4" />
  </IconBase>
);

const AlertCircle = ({ className }) => (
  <IconBase className={className}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 8v4M12 16h.01" />
  </IconBase>
);

const Card = ({ icon: Icon, tone, title, children }) => (
  <section className={classNames(css.card, css[tone])}>
    <div className={css.cardHeader}>
      <span className={css.cardIcon}>
        <Icon className={css.cardIconSvg} />
      </span>
      <h3 className={css.cardTitle}>{title}</h3>
    </div>
    {children}
  </section>
);

/**
 * Rescheduling an accepted booking on the transaction page.
 *
 * - Accepted booking: "Request to reschedule" (once per booking, until 7 days before the start)
 * - Pending request, other party: accept the suggested time, suggest another time or decline.
 *   If the suggested time isn't available anymore, it's still shown, but it can't be accepted.
 * - Pending request, requester: waiting for the other party
 * - After the reschedule loop: how it ended
 *
 * @component
 * @param {Object} props
 * @param {Object|null} props.info Result of getRescheduleInfo
 * @param {Object} props.listing
 * @param {string} props.timeZone Listing's time zone
 * @param {string} props.otherUserDisplayName
 * @param {Object} props.monthlyTimeSlots
 * @param {Object} props.timeSlotsForDate
 * @param {Function} props.onFetchTimeSlots
 * @param {Function} props.onFetchRescheduleTimeSlots
 * @param {Function} props.onReschedule Called with (action, bookingStart): returns a promise
 * @param {string|null} props.rescheduleInProgress The action in progress
 * @param {Object|null} props.rescheduleError
 * @param {Function} props.onManageDisableScrolling
 * @returns {JSX.Element|null}
 */
const Reschedule = props => {
  const intl = useIntl();
  const {
    info,
    listing,
    timeZone,
    otherUserDisplayName,
    timeSlotsForDate,
    onFetchTimeSlots,
    onReschedule,
    rescheduleInProgress,
    rescheduleError,
    ...rest
  } = props;
  const [modalMode, setModalMode] = useState(null);
  const [isConfirmingDecline, setConfirmingDecline] = useState(false);
  // The action whose error is shown: errors show where the action was made (card or modal)
  const [lastAction, setLastAction] = useState(null);

  // The other party checks if the suggested time is still available
  const suggestion = info?.isResponder ? info.suggestion : null;
  const suggestionDay = suggestion ? getStartOf(suggestion.start, 'day', timeZone) : null;
  const suggestionRange = suggestionDay
    ? getDayQueryRange(suggestionDay, timeZone, null, suggestion.end, info.timeUnit)
    : null;
  const suggestionDayData = suggestionRange ? timeSlotsForDate?.[suggestionRange.dateId] : null;

  useEffect(() => {
    if (suggestionRange && listing?.id) {
      const { start, end } = suggestionRange;
      onFetchTimeSlots(listing.id, start, end, timeZone, { useFetchTimeSlotsForDate: true });
    }
  }, [suggestion?.start?.getTime()]);

  if (!info) {
    return null;
  }

  const isAccepting = rescheduleInProgress === 'accept';
  const isDeclining = rescheduleInProgress === 'decline';
  const isBusy = !!rescheduleInProgress;
  const runAction = (action, bookingStart) => {
    setLastAction(action);
    return onReschedule(action, bookingStart);
  };
  const actionError = rescheduleError && !rescheduleInProgress ? rescheduleError : null;
  const cardError = ['accept', 'decline'].includes(lastAction) ? actionError : null;
  const modalError = modalMode && lastAction === modalMode ? actionError : null;
  const errorMessage = getErrorMessage(intl, cardError);
  const time = (start, end) => formatBookingTime(intl, start, end, timeZone);
  const currentTime = time(info.booking.start, info.booking.end);
  const names = { otherUserDisplayName };

  // Accepting failed because the time was booked meanwhile
  const isSuggestionTaken = cardError?.code === 'time-unavailable';
  const availability = !suggestion
    ? null
    : isSuggestionTaken
    ? AVAILABILITY_UNAVAILABLE
    : !suggestionDayData || suggestionDayData.fetchTimeSlotsInProgress
    ? AVAILABILITY_CHECKING
    : isTimeAvailable({
        timeSlots: suggestionDayData.timeSlots,
        start: suggestion.start,
        end: suggestion.end,
        ownBooking: info.booking,
        seats: info.seats,
      }) && suggestion.start > new Date()
    ? AVAILABILITY_AVAILABLE
    : AVAILABILITY_UNAVAILABLE;

  const handleModalSubmit = bookingStart =>
    runAction(modalMode, bookingStart)
      .then(() => setModalMode(null))
      .catch(() => {
        // The error is shown in the modal
      });

  const modal = modalMode ? (
    <RescheduleModal
      id="RescheduleModal"
      isOpen={!!modalMode}
      onClose={() => setModalMode(null)}
      mode={modalMode}
      listing={listing}
      timeZone={timeZone}
      info={info}
      otherUserDisplayName={otherUserDisplayName}
      timeSlotsForDate={timeSlotsForDate}
      onFetchTimeSlots={onFetchTimeSlots}
      onSubmit={handleModalSubmit}
      inProgress={rescheduleInProgress === modalMode}
      errorMessage={getErrorMessage(intl, modalError)}
      {...rest}
    />
  ) : null;

  // Pending request: the other party answers it
  if (info.isResponder && suggestion) {
    const isAvailable = availability === AVAILABILITY_AVAILABLE;
    return (
      <>
        <Card
          icon={CalendarClock}
          tone="attention"
          title={intl.formatMessage({ id: 'TransactionPage.Reschedule.responderTitle' }, names)}
        >
          <dl className={css.times}>
            <dt className={css.timeLabel}>
              <FormattedMessage id="TransactionPage.Reschedule.suggestedTimeLabel" />
            </dt>
            <dd className={classNames(css.timeValue, css.suggestedTime)}>
              {time(suggestion.start, suggestion.end)}
            </dd>
            <dt className={css.timeLabel}>
              <FormattedMessage id="TransactionPage.Reschedule.currentTimeLabel" />
            </dt>
            <dd className={css.timeValue}>{currentTime}</dd>
          </dl>

          {availability === AVAILABILITY_UNAVAILABLE ? (
            <p className={css.warning} role="alert">
              <AlertCircle className={css.warningIcon} />
              <FormattedMessage id="TransactionPage.Reschedule.suggestionUnavailable" />
            </p>
          ) : availability === AVAILABILITY_CHECKING ? (
            <p className={css.note}>
              <FormattedMessage id="TransactionPage.Reschedule.checkingAvailability" />
            </p>
          ) : null}

          {errorMessage && !isSuggestionTaken ? (
            <p className={css.error} role="alert">
              {errorMessage}
            </p>
          ) : null}

          {isConfirmingDecline ? (
            <div className={css.confirm}>
              <p className={css.note}>
                <FormattedMessage id="TransactionPage.Reschedule.declineConfirm" />
              </p>
              <div className={css.actions}>
                <PrimaryButton
                  className={css.primaryButton}
                  type="button"
                  inProgress={isDeclining}
                  disabled={isBusy}
                  onClick={() => runAction('decline').catch(() => {})}
                >
                  <FormattedMessage id="TransactionPage.Reschedule.declineSubmit" />
                </PrimaryButton>
                <SecondaryButton
                  className={css.secondaryButton}
                  type="button"
                  disabled={isBusy}
                  onClick={() => setConfirmingDecline(false)}
                >
                  <FormattedMessage id="TransactionPage.Reschedule.keepRequest" />
                </SecondaryButton>
              </div>
            </div>
          ) : (
            <>
              <div className={css.actions}>
                {isAvailable || availability === AVAILABILITY_CHECKING ? (
                  <PrimaryButton
                    className={css.primaryButton}
                    type="button"
                    inProgress={isAccepting}
                    disabled={!isAvailable || isBusy}
                    onClick={() => runAction('accept').catch(() => {})}
                  >
                    <FormattedMessage id="TransactionPage.Reschedule.accept" />
                  </PrimaryButton>
                ) : null}
                <SecondaryButton
                  className={css.secondaryButton}
                  type="button"
                  disabled={isBusy}
                  onClick={() => setModalMode('counter')}
                >
                  <FormattedMessage id="TransactionPage.Reschedule.suggestAnotherTime" />
                </SecondaryButton>
              </div>
              <InlineTextButton
                className={css.declineLink}
                type="button"
                disabled={isBusy}
                onClick={() => setConfirmingDecline(true)}
              >
                <FormattedMessage id="TransactionPage.Reschedule.decline" />
              </InlineTextButton>
            </>
          )}
        </Card>
        {modal}
      </>
    );
  }

  // Pending request: the requester waits for the other party
  if (info.isRequester && info.suggestion) {
    return (
      <Card
        icon={CalendarClock}
        tone="neutral"
        title={intl.formatMessage({ id: 'TransactionPage.Reschedule.requesterTitle' }, names)}
      >
        <dl className={css.times}>
          <dt className={css.timeLabel}>
            <FormattedMessage id="TransactionPage.Reschedule.yourSuggestionLabel" />
          </dt>
          <dd className={classNames(css.timeValue, css.suggestedTime)}>
            {time(info.suggestion.start, info.suggestion.end)}
          </dd>
          <dt className={css.timeLabel}>
            <FormattedMessage id="TransactionPage.Reschedule.currentTimeLabel" />
          </dt>
          <dd className={css.timeValue}>{currentTime}</dd>
        </dl>
        <p className={css.note}>
          <FormattedMessage id="TransactionPage.Reschedule.requesterNote" values={names} />
        </p>
      </Card>
    );
  }

  // The reschedule loop has ended
  if (info.outcome === OUTCOME_ACCEPTED) {
    return (
      <Card
        icon={CalendarCheck}
        tone="success"
        title={intl.formatMessage({ id: 'TransactionPage.Reschedule.acceptedTitle' })}
      >
        <p className={css.note}>
          {info.previousBooking ? (
            <FormattedMessage
              id="TransactionPage.Reschedule.acceptedFromTo"
              values={{
                from: time(info.previousBooking.start, info.previousBooking.end),
                to: currentTime,
              }}
            />
          ) : (
            <FormattedMessage
              id="TransactionPage.Reschedule.acceptedTo"
              values={{ to: currentTime }}
            />
          )}
        </p>
      </Card>
    );
  }
  if (info.outcome === OUTCOME_DECLINED || info.outcome === OUTCOME_EXPIRED) {
    const messageId =
      info.outcome === OUTCOME_EXPIRED
        ? 'TransactionPage.Reschedule.expiredNote'
        : info.outcomeByYou
        ? 'TransactionPage.Reschedule.declinedByYouNote'
        : 'TransactionPage.Reschedule.declinedNote';
    return (
      <Card
        icon={CalendarX}
        tone="neutral"
        title={intl.formatMessage({ id: 'TransactionPage.Reschedule.notRescheduledTitle' })}
      >
        <p className={css.note}>
          <FormattedMessage id={messageId} values={{ ...names, time: currentTime }} />
        </p>
      </Card>
    );
  }

  // Accepted booking: the first (and only) reschedule can be requested
  if (info.canRequest) {
    return (
      <>
        <Card
          icon={CalendarClock}
          tone="neutral"
          title={intl.formatMessage({ id: 'TransactionPage.Reschedule.requestTitle' })}
        >
          <p className={css.note}>
            <FormattedMessage
              id="TransactionPage.Reschedule.requestDescription"
              values={{
                ...names,
                deadline: intl.formatDate(info.requestDeadline, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                  timeZone,
                }),
              }}
            />
          </p>
          <SecondaryButton
            className={css.secondaryButton}
            type="button"
            onClick={() => setModalMode('request')}
          >
            <FormattedMessage id="TransactionPage.Reschedule.requestButton" />
          </SecondaryButton>
        </Card>
        {modal}
      </>
    );
  }

  return null;
};

export default Reschedule;
