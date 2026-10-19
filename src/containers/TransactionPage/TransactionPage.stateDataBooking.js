import {
  TX_TRANSITION_ACTOR_CUSTOMER as CUSTOMER,
  TX_TRANSITION_ACTOR_PROVIDER as PROVIDER,
  CONDITIONAL_RESOLVER_WILDCARD,
  ConditionalResolver,
} from '../../transactions/transaction';

// Activity feed messages for the reschedule transitions. Most of them lead back to the accepted
// state, so the default (state based) message would be wrong.
const getRescheduleTransitionMessages = transitions => {
  const messageId = key => `TransactionPage.ActivityFeed.default-booking.${key}`;
  return [
    [transitions.REQUEST_RESCHEDULE_BY_CUSTOMER, 'rescheduleRequested'],
    [transitions.REQUEST_RESCHEDULE_BY_PROVIDER, 'rescheduleRequested'],
    [transitions.COUNTER_RESCHEDULE_BY_CUSTOMER, 'rescheduleCountered'],
    [transitions.COUNTER_RESCHEDULE_BY_PROVIDER, 'rescheduleCountered'],
    [transitions.ACCEPT_RESCHEDULE_BY_CUSTOMER, 'rescheduleAccepted'],
    [transitions.ACCEPT_RESCHEDULE_BY_PROVIDER, 'rescheduleAccepted'],
    [transitions.DECLINE_RESCHEDULE_BY_CUSTOMER, 'rescheduleDeclined'],
    [transitions.DECLINE_RESCHEDULE_BY_PROVIDER, 'rescheduleDeclined'],
    [transitions.EXPIRE_RESCHEDULE_REQUESTED_BY_CUSTOMER, 'rescheduleExpired'],
    [transitions.EXPIRE_RESCHEDULE_REQUESTED_BY_PROVIDER, 'rescheduleExpired'],
  ]
    .filter(([transition]) => !!transition)
    .map(([transition, key]) => ({ transition, translationId: messageId(key) }));
};

/**
 * Get state data against booking process for TransactionPage's UI.
 * I.e. info about showing action buttons, current state etc.
 *
 * @param {*} txInfo detials about transaction
 * @param {*} processInfo  details about process
 */
export const getStateDataForBookingProcess = (txInfo, processInfo) => {
  const stateData = getBookingStateData(txInfo, processInfo);
  return {
    ...stateData,
    transitionMessages: getRescheduleTransitionMessages(processInfo.transitions),
  };
};

const getBookingStateData = (txInfo, processInfo) => {
  const { transaction, transactionRole, nextTransitions } = txInfo;
  const isProviderBanned = transaction?.provider?.attributes?.banned;
  const isCustomerBanned = transaction?.provider?.attributes?.banned;
  const _ = CONDITIONAL_RESOLVER_WILDCARD;

  const {
    processName,
    processState,
    states,
    transitions,
    isCustomer,
    actionButtonProps,
    leaveReviewProps,
  } = processInfo;

  return new ConditionalResolver([processState, transactionRole])
    .cond([states.INQUIRY, CUSTOMER], () => {
      const transitionNames = Array.isArray(nextTransitions)
        ? nextTransitions.map(t => t.attributes.name)
        : [];
      const requestAfterInquiry = transitions.REQUEST_PAYMENT_AFTER_INQUIRY;
      const hasCorrectNextTransition = transitionNames.includes(requestAfterInquiry);
      const showOrderPanel = !isProviderBanned && hasCorrectNextTransition;
      return { processName, processState, showOrderPanel, showDetailCardHeadings: true };
    })
    .cond([states.INQUIRY, PROVIDER], () => {
      return { processName, processState, showDetailCardHeadings: true };
    })
    .cond([states.PREAUTHORIZED, CUSTOMER], () => {
      return { processName, processState, showDetailCardHeadings: true, showExtraInfo: true };
    })
    .cond([states.PREAUTHORIZED, PROVIDER], () => {
      const primary = isCustomerBanned ? null : actionButtonProps(transitions.ACCEPT, PROVIDER);
      const secondary = isCustomerBanned ? null : actionButtonProps(transitions.DECLINE, PROVIDER);
      return {
        processName,
        processState,
        showDetailCardHeadings: true,
        showActionButtons: true,
        primaryButtonProps: primary,
        secondaryButtonProps: secondary,
      };
    })
    .cond([states.DELIVERED, _], () => {
      return {
        processName,
        processState,
        showDetailCardHeadings: true,
        showReviewAsFirstLink: true,
        showActionButtons: true,
        primaryButtonProps: leaveReviewProps,
      };
    })
    .cond([states.REVIEWED_BY_PROVIDER, CUSTOMER], () => {
      return {
        processName,
        processState,
        showDetailCardHeadings: true,
        showReviewAsSecondLink: true,
        showActionButtons: true,
        primaryButtonProps: leaveReviewProps,
      };
    })
    .cond([states.REVIEWED_BY_CUSTOMER, PROVIDER], () => {
      return {
        processName,
        processState,
        showDetailCardHeadings: true,
        showReviewAsSecondLink: true,
        showActionButtons: true,
        primaryButtonProps: leaveReviewProps,
      };
    })
    .cond([states.REVIEWED, _], () => {
      return { processName, processState, showDetailCardHeadings: true, showReviews: true };
    })
    .default(() => {
      // Default values for other states
      return { processName, processState, showDetailCardHeadings: true };
    })
    .resolve();
};
