import {
  BOOKING_PROCESS_NAME,
  getProcess,
  resolveLatestProcessName,
} from '../../../transactions/transaction';
import { getMatchingCancellationRule, getPolicies } from '../../../util/policies';

// Keep these rules in sync with server/services/cancellation, which enforces them.

/**
 * Cancellation status of a booking for the transaction page. Only customers can cancel:
 *
 *  - before the booking is accepted, for free
 *  - after it's accepted, when a cancellation rule of the policies copied to the booking applies
 *
 * @param {Object} params
 * @param {Object} params.transaction The transaction, with the booking
 * @param {'customer'|'provider'} params.transactionRole
 * @param {Array<Object>} params.nextTransitions Transitions the current user can make now. They
 * tell if the transaction's process version supports cancellations.
 * @param {Date} [params.now]
 * @returns {Object|null} null if cancellation doesn't apply to the transaction
 */
export const getCancellationInfo = ({ transaction, transactionRole, nextTransitions, now }) => {
  const processName = resolveLatestProcessName(transaction?.attributes?.processName);
  const booking = transaction?.booking;
  if (processName !== BOOKING_PROCESS_NAME || !booking?.attributes?.start) {
    return null;
  }

  const t = getProcess(processName).transitions;
  const { lastTransition, metadata = {}, protectedData = {} } = transaction.attributes || {};
  const currentTime = now || new Date();
  const isCustomer = transactionRole === 'customer';
  const nextTransitionNames = (nextTransitions || []).map(nt => nt?.attributes?.name);
  const { start, end } = booking.attributes;

  const acceptedCancelTransitions = [
    t.CUSTOMER_CANCEL,
    t.CUSTOMER_CANCEL_RESCHEDULE_REQUESTED_BY_CUSTOMER,
    t.CUSTOMER_CANCEL_RESCHEDULE_REQUESTED_BY_PROVIDER,
    t.CUSTOMER_CANCEL_NO_REFUND,
    t.CUSTOMER_CANCEL_NO_REFUND_RESCHEDULE_REQUESTED_BY_CUSTOMER,
    t.CUSTOMER_CANCEL_NO_REFUND_RESCHEDULE_REQUESTED_BY_PROVIDER,
  ];

  // Before the booking is accepted: free
  const canCancelRequest = isCustomer && nextTransitionNames.includes(t.CUSTOMER_CANCEL_REQUEST);

  // After the booking is accepted: by the policies copied to the booking
  const isAccepted =
    isCustomer && acceptedCancelTransitions.some(tr => nextTransitionNames.includes(tr));
  const policies = protectedData.policies || null;
  const timeUntilStart = start.getTime() - currentTime.getTime();
  const applicableRule =
    isAccepted && timeUntilStart > 0
      ? getMatchingCancellationRule(getPolicies(policies).cancellation.rules, timeUntilStart)
      : null;

  const isCancelledRequest = lastTransition === t.CUSTOMER_CANCEL_REQUEST;
  const isCancelled =
    acceptedCancelTransitions.includes(lastTransition) ||
    lastTransition === t.PAYOUT_CANCELLED_WITHOUT_REFUND;

  if (!canCancelRequest && !isAccepted && !isCancelledRequest && !isCancelled) {
    return null;
  }

  return {
    canCancelRequest,
    // Accepted booking: can be cancelled now (a rule applies) or not
    isAccepted,
    canCancel: !!applicableRule,
    applicableRule,
    policies,
    isCancelledRequest,
    isCancelled,
    // Cancellation details stored by the server: amounts in minor units
    cancellation: metadata.cancellation || null,
    // Cancelling a pending reschedule request of the provider clears the customer's notification
    refreshNotifications: [
      t.REQUEST_RESCHEDULE_BY_PROVIDER,
      t.COUNTER_RESCHEDULE_BY_PROVIDER,
    ].includes(lastTransition),
    booking: { start, end },
  };
};
