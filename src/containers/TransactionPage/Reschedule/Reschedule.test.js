import React from 'react';
import '@testing-library/jest-dom';

import { renderWithProviders as render, testingLibrary } from '../../../util/testHelpers';

import Reschedule from './Reschedule';

const { screen, userEvent } = testingLibrary;

const HOUR_MS = 60 * 60 * 1000;
const start = new Date(Date.now() + 10 * 24 * HOUR_MS);
const booking = { start, end: new Date(start.getTime() + 3 * HOUR_MS) };
const suggestion = {
  start: new Date(start.getTime() + 24 * HOUR_MS),
  end: new Date(start.getTime() + 27 * HOUR_MS),
};

const baseProps = {
  listing: { id: { uuid: 'listing-1' }, attributes: {} },
  timeZone: 'Etc/UTC',
  otherUserDisplayName: 'Pat',
  monthlyTimeSlots: {},
  onFetchTimeSlots: jest.fn(() => Promise.resolve()),
  onFetchRescheduleTimeSlots: jest.fn(),
  onReschedule: jest.fn(() => Promise.resolve()),
  onManageDisableScrolling: jest.fn(),
  rescheduleInProgress: null,
  rescheduleError: null,
};

const responderInfo = {
  stage: 'requested-by-customer',
  isResponder: true,
  isRequester: false,
  suggestion,
  booking,
  durationMs: 3 * HOUR_MS,
  seats: 1,
  timeUnit: 'hour',
  maxStart: new Date(start.getTime() + 60 * 24 * HOUR_MS),
};

// Time slots of the suggested day
const dateId = suggestion.start.toISOString().slice(0, 10);
const timeSlotsFor = (slotStart, slotEnd) => ({
  [dateId]: {
    timeSlots: [{ attributes: { start: slotStart, end: slotEnd, seats: 1 } }],
    fetchTimeSlotsInProgress: false,
  },
});

describe('Reschedule', () => {
  it('lets the other party accept a suggested time that is available', async () => {
    const onReschedule = jest.fn(() => Promise.resolve());
    render(
      <Reschedule
        {...baseProps}
        onReschedule={onReschedule}
        info={responderInfo}
        timeSlotsForDate={timeSlotsFor(suggestion.start, suggestion.end)}
      />
    );

    expect(screen.getByText('TransactionPage.Reschedule.responderTitle')).toBeInTheDocument();
    const accept = screen.getByRole('button', { name: 'TransactionPage.Reschedule.accept' });
    expect(accept).toBeEnabled();
    await userEvent.click(accept);
    expect(onReschedule).toHaveBeenCalledWith('accept', undefined);
  });

  it("shows a suggested time that isn't available anymore, without the accept button", () => {
    render(
      <Reschedule
        {...baseProps}
        info={responderInfo}
        timeSlotsForDate={timeSlotsFor(
          suggestion.start,
          new Date(suggestion.start.getTime() + HOUR_MS)
        )}
      />
    );

    expect(
      screen.getByText('TransactionPage.Reschedule.suggestionUnavailable')
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'TransactionPage.Reschedule.accept' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'TransactionPage.Reschedule.suggestAnotherTime' })
    ).toBeEnabled();
  });

  it('shows the request button on an accepted booking', () => {
    render(
      <Reschedule
        {...baseProps}
        timeSlotsForDate={{}}
        info={{
          stage: 'accepted',
          canRequest: true,
          requestDeadline: new Date(start.getTime() - 7 * 24 * HOUR_MS),
          booking,
          durationMs: 3 * HOUR_MS,
        }}
      />
    );
    expect(
      screen.getByRole('button', { name: 'TransactionPage.Reschedule.requestButton' })
    ).toBeInTheDocument();
  });
});
