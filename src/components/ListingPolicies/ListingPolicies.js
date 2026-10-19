import React from 'react';
import classNames from 'classnames';

import { FormattedMessage, useIntl } from '../../util/reactIntl';
import { getPolicies } from '../../util/policies';

import css from './ListingPolicies.module.css';

/**
 * "Cancelled more than 48 hours before the start", for a cancellation rule.
 *
 * @param {Object} intl
 * @param {Object} rule Sanitized rule (see src/util/policies.js)
 * @returns {string}
 */
export const formatRuleCondition = (intl, rule) =>
  intl.formatMessage(
    { id: `ListingPolicies.ruleCondition.${rule.comparison}` },
    { amount: rule.amount, unit: rule.unit }
  );

/**
 * A listing's cancellation and rescheduling policies, as set by the provider. Shown on the
 * listing page and with the cancellation of a booking (with the policies copied to the booking).
 *
 * @component
 * @param {Object} props
 * @param {string} [props.className]
 * @param {Object} [props.policies] publicData.policies of a listing or protectedData.policies of
 * a transaction
 * @param {boolean} [props.showReschedule] Show the rescheduling policy too
 * @param {string} [props.highlightedRuleHeading] Heading of the rule that applies now
 * @returns {JSX.Element}
 */
const ListingPolicies = props => {
  const intl = useIntl();
  const { className, policies, showReschedule = true, highlightedRuleHeading } = props;
  const { reschedule, cancellation, bookingCutoff } = getPolicies(policies);
  const hasRules = cancellation.rules.length > 0;

  return (
    <div className={classNames(css.root, className)}>
      <ul className={css.list}>
        <li className={css.item}>
          <FormattedMessage id="ListingPolicies.freeBeforeAccept" />
        </li>
        {hasRules ? (
          cancellation.rules.map((rule, index) => (
            <li
              key={`${rule.heading}-${index}`}
              className={classNames(css.item, {
                [css.highlighted]: rule.heading === highlightedRuleHeading,
              })}
            >
              <span className={css.ruleHeading}>{rule.heading}</span>
              <FormattedMessage
                id="ListingPolicies.rule"
                values={{
                  condition: formatRuleCondition(intl, rule),
                  refundPercentage: rule.refundPercentage,
                }}
              />
            </li>
          ))
        ) : (
          <li className={css.item}>
            <FormattedMessage id="ListingPolicies.noCancellationAfterAccept" />
          </li>
        )}
      </ul>
      {hasRules ? (
        <p className={css.note}>
          <FormattedMessage id="ListingPolicies.stripeFeeNonRefundable" />
        </p>
      ) : null}
      {showReschedule && bookingCutoff ? (
        <p className={css.reschedule}>
          <FormattedMessage
            id="ListingPolicies.bookingCutoff"
            values={{ amount: bookingCutoff.amount, unit: bookingCutoff.unit }}
          />
        </p>
      ) : null}
      {showReschedule ? (
        <p className={css.reschedule}>
          {reschedule.allowed ? (
            <FormattedMessage
              id="ListingPolicies.rescheduleAllowed"
              values={{ amount: reschedule.minNoticeAmount, unit: reschedule.minNoticeUnit }}
            />
          ) : (
            <FormattedMessage id="ListingPolicies.rescheduleNotAllowed" />
          )}
        </p>
      ) : null}
    </div>
  );
};

export default ListingPolicies;
