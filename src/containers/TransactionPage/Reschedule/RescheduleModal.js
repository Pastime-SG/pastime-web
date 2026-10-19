import React, { useEffect, useState } from 'react';
import { Form as FinalForm } from 'react-final-form';

import { FormattedMessage, useIntl } from '../../../util/reactIntl';
import {
  getStartOf,
  monthIdString,
  stringifyDateToISO8601,
  timeOfDayFromLocalToTimeZone,
  timeOfDayFromTimeZoneToLocal,
} from '../../../util/dates';
import { bookingDateRequired, required } from '../../../util/validators';

import {
  FieldSelect,
  FieldSingleDatePicker,
  Form,
  Modal,
  PrimaryButton,
} from '../../../components';

import {
  formatBookingTime,
  getAvailableDays,
  getDayQueryRange,
  getStartTimeOptions,
} from './Reschedule.helpers';

import css from './Reschedule.module.css';

const MINUTE_MS = 60 * 1000;

// Monthly time slots: one per day, counting only free times long enough for the booking
const getMonthQueryOptions = (intervalAlign, durationMinutes) => ({
  extraQueryParams: {
    intervalDuration: 'P1D',
    intervalAlign,
    maxPerInterval: 1,
    minDurationStartingInInterval: durationMinutes,
    perPage: 31,
    page: 1,
  },
});

/**
 * Form for picking the new date and start time. The end time follows from the booking's duration.
 */
const RescheduleForm = props => {
  const intl = useIntl();
  const {
    listing,
    timeZone,
    info,
    monthlyTimeSlots,
    timeSlotsForDate,
    onFetchTimeSlots,
    submitLabel,
    inProgress,
    errorMessage,
    onSubmit,
  } = props;
  const { booking, durationMs, seats, timeUnit, maxStart } = info;
  const durationMinutes = Math.round(durationMs / MINUTE_MS);
  const today = getStartOf(new Date(), 'day', timeZone);
  const [currentMonth, setCurrentMonth] = useState(getStartOf(today, 'month', timeZone));

  const availableDays = getAvailableDays(monthlyTimeSlots, timeZone, durationMinutes);
  // The booking's own day stays selectable: moving it on the same day is possible
  const bookingDateId = stringifyDateToISO8601(booking.start, timeZone);

  const toDayInTimeZone = day =>
    getStartOf(timeOfDayFromLocalToTimeZone(day, timeZone), 'day', timeZone);

  const isOutsideRange = day => {
    const dayInTimeZone = toDayInTimeZone(day);
    return dayInTimeZone < today || dayInTimeZone > maxStart;
  };

  const isDayBlocked = day => {
    const dateId = stringifyDateToISO8601(toDayInTimeZone(day), timeZone);
    return !availableDays[dateId] && dateId !== bookingDateId;
  };

  const fetchDay = dayStart => {
    const { start, end } = getDayQueryRange(dayStart, timeZone, null, null, timeUnit);
    return onFetchTimeSlots(listing.id, start, end, timeZone, { useFetchTimeSlotsForDate: true });
  };

  // Months after the first two are fetched when the user moves to them in the calendar
  const handleMonthChange = date => {
    const monthStart = getStartOf(timeOfDayFromLocalToTimeZone(date, timeZone), 'month', timeZone);
    setCurrentMonth(monthStart);
    const monthId = monthIdString(monthStart, timeZone);
    if (!monthlyTimeSlots?.[monthId] && monthStart <= maxStart) {
      // Sessions that start on the last evening of the month can end in the next month
      const nextMonth = getStartOf(monthStart, 'month', timeZone, 1, 'months');
      const monthEnd = getStartOf(nextMonth, 'minute', timeZone, durationMinutes, 'minutes');
      onFetchTimeSlots(
        listing.id,
        monthStart,
        monthEnd,
        timeZone,
        getMonthQueryOptions(monthStart, durationMinutes)
      );
    }
  };

  const thisMonth = getStartOf(today, 'month', timeZone);
  const nextMonth = getStartOf(currentMonth, 'month', timeZone, 1, 'months');

  return (
    <FinalForm
      onSubmit={values => onSubmit(new Date(Number(values.startTime)))}
      render={({ handleSubmit, values, form, invalid }) => {
        const selectedDay = values.date?.date
          ? getStartOf(values.date.date, 'day', timeZone)
          : null;
        const selectedDateId = selectedDay ? stringifyDateToISO8601(selectedDay, timeZone) : null;
        const dayData = selectedDateId ? timeSlotsForDate?.[selectedDateId] : null;
        const startTimeOptions = selectedDay
          ? getStartTimeOptions({
              dayStart: selectedDay,
              timeZone,
              timeSlots: dayData?.timeSlots || [],
              ownBooking: booking,
              durationMs,
              seats,
              timeUnit,
              maxStart,
            })
          : [];
        const isLoadingTimes = selectedDay && (!dayData || dayData.fetchTimeSlotsInProgress);
        const selectedOption = startTimeOptions.find(
          o => `${o.start.getTime()}` === values.startTime
        );

        return (
          <Form onSubmit={handleSubmit} className={css.form}>
            <FieldSingleDatePicker
              className={css.field}
              inputClassName={css.dateInput}
              popupClassName={css.datePopup}
              name="date"
              id="RescheduleForm.date"
              label={intl.formatMessage({ id: 'TransactionPage.Reschedule.dateLabel' })}
              placeholderText={intl.formatMessage({
                id: 'TransactionPage.Reschedule.datePlaceholder',
              })}
              format={v =>
                v && v.date ? { date: timeOfDayFromTimeZoneToLocal(v.date, timeZone) } : v
              }
              parse={v =>
                v && v.date ? { date: timeOfDayFromLocalToTimeZone(v.date, timeZone) } : v
              }
              isDayBlocked={isDayBlocked}
              isOutsideRange={isOutsideRange}
              showPreviousMonthStepper={currentMonth > thisMonth}
              showNextMonthStepper={nextMonth <= maxStart}
              onMonthChange={handleMonthChange}
              onChange={value => {
                form.change('startTime', undefined);
                // The raw value is in the browser's local time
                if (value?.date) {
                  fetchDay(toDayInTimeZone(value.date));
                }
              }}
              validate={bookingDateRequired(
                intl.formatMessage({ id: 'TransactionPage.Reschedule.dateRequired' })
              )}
              useMobileMargins={false}
            />

            <FieldSelect
              className={css.field}
              name="startTime"
              id="RescheduleForm.startTime"
              label={intl.formatMessage({ id: 'TransactionPage.Reschedule.startTimeLabel' })}
              disabled={!selectedDay || isLoadingTimes || startTimeOptions.length === 0}
              validate={required(
                intl.formatMessage({ id: 'TransactionPage.Reschedule.startTimeRequired' })
              )}
            >
              <option value="">
                {intl.formatMessage({
                  id: !selectedDay
                    ? 'TransactionPage.Reschedule.pickDateFirst'
                    : isLoadingTimes
                    ? 'TransactionPage.Reschedule.loadingTimes'
                    : startTimeOptions.length === 0
                    ? 'TransactionPage.Reschedule.noTimes'
                    : 'TransactionPage.Reschedule.startTimePlaceholder',
                })}
              </option>
              {startTimeOptions.map(o => (
                <option key={o.start.getTime()} value={`${o.start.getTime()}`}>
                  {intl.formatTime(o.start, { hour: 'numeric', minute: '2-digit', timeZone })}
                </option>
              ))}
            </FieldSelect>

            <div className={css.endTime}>
              <span className={css.endTimeLabel}>
                <FormattedMessage id="TransactionPage.Reschedule.endTimeLabel" />
              </span>
              <span className={css.endTimeValue}>
                {selectedOption
                  ? intl.formatTime(selectedOption.end, {
                      hour: 'numeric',
                      minute: '2-digit',
                      timeZone,
                    })
                  : '–'}
              </span>
              <span className={css.endTimeNote}>
                <FormattedMessage
                  id="TransactionPage.Reschedule.sameDuration"
                  values={{
                    hours: Math.floor(durationMinutes / 60),
                    minutes: durationMinutes % 60,
                  }}
                />
              </span>
            </div>

            {selectedOption ? (
              <p className={css.newTime}>
                <FormattedMessage
                  id="TransactionPage.Reschedule.newTime"
                  values={{
                    time: formatBookingTime(
                      intl,
                      selectedOption.start,
                      selectedOption.end,
                      timeZone
                    ),
                  }}
                />
              </p>
            ) : null}

            {errorMessage ? (
              <p className={css.error} role="alert">
                {errorMessage}
              </p>
            ) : null}

            <PrimaryButton
              className={css.submitButton}
              type="submit"
              inProgress={inProgress}
              disabled={invalid || inProgress || !selectedOption}
            >
              {submitLabel}
            </PrimaryButton>
          </Form>
        );
      }}
    />
  );
};

/**
 * Modal for requesting a new time for an accepted booking, or suggesting another time.
 *
 * Availability is loaded the same way as on the listing page: monthly data to mark the days that
 * have a free time long enough for the booking, then the time slots of the selected day. Only the
 * start time is chosen: the booking keeps its duration (and price).
 *
 * @component
 * @param {Object} props
 * @param {string} props.id
 * @param {boolean} props.isOpen
 * @param {Function} props.onClose
 * @param {Function} props.onManageDisableScrolling
 * @param {'request'|'counter'} props.mode
 * @param {Object} props.listing
 * @param {string} props.timeZone Listing's time zone
 * @param {Object} props.info Result of getRescheduleInfo
 * @param {string} props.otherUserDisplayName
 * @param {Object} props.monthlyTimeSlots
 * @param {Object} props.timeSlotsForDate
 * @param {Function} props.onFetchTimeSlots
 * @param {Function} props.onFetchRescheduleTimeSlots
 * @param {Function} props.onSubmit Called with the new start (Date)
 * @param {boolean} props.inProgress
 * @param {string} [props.errorMessage]
 * @returns {JSX.Element}
 */
const RescheduleModal = props => {
  const intl = useIntl();
  const {
    id,
    isOpen,
    onClose,
    onManageDisableScrolling,
    mode,
    listing,
    timeZone,
    info,
    otherUserDisplayName,
    onFetchRescheduleTimeSlots,
    ...rest
  } = props;
  const durationMinutes = Math.round(info.durationMs / MINUTE_MS);

  useEffect(() => {
    if (isOpen) {
      onFetchRescheduleTimeSlots(listing, durationMinutes);
    }
  }, [isOpen]);

  const isCounter = mode === 'counter';

  return (
    <Modal
      id={id}
      containerClassName={css.modalContainer}
      isOpen={isOpen}
      onClose={onClose}
      onManageDisableScrolling={onManageDisableScrolling}
      usePortal
    >
      <h2 className={css.modalTitle}>
        <FormattedMessage
          id={
            isCounter
              ? 'TransactionPage.Reschedule.counterModalTitle'
              : 'TransactionPage.Reschedule.requestModalTitle'
          }
        />
      </h2>
      <p className={css.modalDescription}>
        <FormattedMessage
          id="TransactionPage.Reschedule.modalDescription"
          values={{ otherUserDisplayName }}
        />
      </p>
      <p className={css.currentTime}>
        <FormattedMessage
          id="TransactionPage.Reschedule.currentTime"
          values={{
            time: formatBookingTime(intl, info.booking.start, info.booking.end, timeZone),
          }}
        />
      </p>
      {isOpen ? (
        <RescheduleForm
          listing={listing}
          timeZone={timeZone}
          info={info}
          submitLabel={intl.formatMessage({
            id: isCounter
              ? 'TransactionPage.Reschedule.counterSubmit'
              : 'TransactionPage.Reschedule.requestSubmit',
          })}
          {...rest}
        />
      ) : null}
    </Modal>
  );
};

export default RescheduleModal;
