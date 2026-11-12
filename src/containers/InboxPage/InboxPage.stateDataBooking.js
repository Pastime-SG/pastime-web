import {
  TX_TRANSITION_ACTOR_CUSTOMER as CUSTOMER,
  TX_TRANSITION_ACTOR_PROVIDER as PROVIDER,
  CONDITIONAL_RESOLVER_WILDCARD,
  ConditionalResolver,
} from '../../transactions/transaction';

// Get UI data mapped to specific transaction state & role
export const getStateDataForBookingProcess = (txInfo, processInfo) => {
  const { transactionRole } = txInfo;
  const { processName, processState, states } = processInfo;
  const _ = CONDITIONAL_RESOLVER_WILDCARD;

  return (
    new ConditionalResolver([processState, transactionRole])
      .cond([states.INQUIRY, _], () => {
        return { processName, processState, actionNeeded: true };
      })
      .cond([states.PENDING_PAYMENT, CUSTOMER], () => {
        return { processName, processState, actionNeeded: true };
      })
      .cond([states.CANCELED, _], () => {
        return { processName, processState, isFinal: true };
      })
      .cond([states.CANCELLED_WITHOUT_REFUND, _], () => {
        return { processName, processState, isFinal: true };
      })
      .cond([states.PREAUTHORIZED, PROVIDER], () => {
        return { processName, processState, actionNeeded: true, isSaleNotification: true };
      })
      .cond([states.ACCEPTED, _], () => {
        return { processName, processState, actionNeeded: true };
      })
      // The other party of a reschedule request needs to answer it
      .cond([states.RESCHEDULE_REQUESTED_BY_CUSTOMER, PROVIDER], () => {
        return { processName, processState, actionNeeded: true, isSaleNotification: true };
      })
      .cond([states.RESCHEDULE_REQUESTED_BY_PROVIDER, CUSTOMER], () => {
        return { processName, processState, actionNeeded: true, isOrderNotification: true };
      })
      .cond([states.RESCHEDULE_REQUESTED_BY_CUSTOMER, _], () => {
        return { processName, processState, actionNeeded: true };
      })
      .cond([states.RESCHEDULE_REQUESTED_BY_PROVIDER, _], () => {
        return { processName, processState, actionNeeded: true };
      })
      .cond([states.DECLINED, _], () => {
        return { processName, processState, isFinal: true };
      })
      .cond([states.EXPIRED, _], () => {
        return { processName, processState, isFinal: true };
      })
      // Only the customer reviews the provider: for the provider, the booking is completed
      .cond([states.DELIVERED, CUSTOMER], () => {
        return { processName, processState, actionNeeded: true };
      })
      .cond([states.DELIVERED, PROVIDER], () => {
        return { processName, processState, isFinal: true };
      })
      .cond([states.REVIEWED_BY_PROVIDER, CUSTOMER], () => {
        return { processName, processState, actionNeeded: true };
      })
      .cond([states.REVIEWED_BY_CUSTOMER, _], () => {
        return { processName, processState, isFinal: true };
      })
      .cond([states.REVIEWED, _], () => {
        return { processName, processState, isFinal: true };
      })
      .default(() => {
        // Default values for other states
        return { processName, processState };
      })
      .resolve()
  );
};
