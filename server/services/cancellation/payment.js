const { getPaymentDetails } = require('./index');
const { findPaymentIntentsForTransaction, retrievePaymentIntent } = require('../stripe');

/**
 * The captured Stripe payment of a booking (cancellations and Pastime's payouts).
 */

const paymentNotFound = () => {
  const error = new Error('Payment not found');
  error.code = 'payment-not-found';
  return error;
};

// The PaymentIntent stored with the transaction by Sharetribe (stripe-create-payment-intent), if
// it belongs to this transaction, or else one found by searching Stripe. Searching only finds
// PaymentIntents after about a minute, so it's the fallback.
const findPaymentIntent = async (transactionId, protectedData) => {
  const storedId = protectedData?.stripePaymentIntents?.default?.stripePaymentIntentId;
  if (typeof storedId === 'string' && /^pi_[A-Za-z0-9]+$/.test(storedId)) {
    const pi = await retrievePaymentIntent(storedId).catch(() => null);
    if (pi?.metadata?.['sharetribe-transaction-id'] === transactionId) {
      return pi;
    }
  }
  const found = await findPaymentIntentsForTransaction(transactionId);
  const match = found.find(pi => pi.status === 'succeeded');
  return match ? retrievePaymentIntent(match.id) : null;
};

// The captured PaymentIntent of the transaction
const getPayment = async (transactionId, protectedData) => {
  const pi = await findPaymentIntent(transactionId, protectedData);
  if (pi?.status !== 'succeeded') {
    throw paymentNotFound();
  }
  return { paymentIntentId: pi.id, payment: getPaymentDetails(pi) };
};

module.exports = { getPayment };
