import React from 'react';
import classNames from 'classnames';

// Import configs and util modules
import { FormattedMessage } from '../../../../util/reactIntl';
import { LISTING_STATE_DRAFT, propTypes } from '../../../../util/types';
import { UNIT_HOURS, getPolicies } from '../../../../util/policies';

// Import shared components
import { H3, ListingLink } from '../../../../components';

// Import modules from this directory
import EditListingPoliciesForm, {
  RESCHEDULE_ALLOWED,
  RESCHEDULE_NOT_ALLOWED,
} from './EditListingPoliciesForm';
import css from './EditListingPoliciesPanel.module.css';

const getInitialValues = listing => {
  const { reschedule, cancellation, bookingCutoff } = getPolicies(
    listing?.attributes?.publicData?.policies
  );
  return {
    rescheduleAllowed: reschedule.allowed ? RESCHEDULE_ALLOWED : RESCHEDULE_NOT_ALLOWED,
    rescheduleNoticeAmount: reschedule.allowed ? `${reschedule.minNoticeAmount}` : '',
    rescheduleNoticeUnit: reschedule.allowed ? reschedule.minNoticeUnit : UNIT_HOURS,
    // No cutoff by default
    bookingCutoffAmount: bookingCutoff ? `${bookingCutoff.amount}` : '',
    bookingCutoffUnit: bookingCutoff ? bookingCutoff.unit : UNIT_HOURS,
    cancellationRules: cancellation.rules.map(rule => ({
      ...rule,
      amount: `${rule.amount}`,
      refundPercentage: `${rule.refundPercentage}`,
    })),
  };
};

// Form values to publicData.policies (see src/util/policies.js)
const toPolicies = values => {
  const {
    rescheduleAllowed,
    rescheduleNoticeAmount,
    rescheduleNoticeUnit,
    bookingCutoffAmount,
    bookingCutoffUnit,
    cancellationRules = [],
  } = values;
  const hasBookingCutoff = bookingCutoffAmount != null && `${bookingCutoffAmount}`.trim() !== '';
  const allowsReschedule = rescheduleAllowed === RESCHEDULE_ALLOWED;
  return {
    reschedule: allowsReschedule
      ? {
          allowed: true,
          minNoticeAmount: Number(rescheduleNoticeAmount),
          minNoticeUnit: rescheduleNoticeUnit,
        }
      : { allowed: false },
    bookingCutoff: hasBookingCutoff
      ? { amount: Number(bookingCutoffAmount), unit: bookingCutoffUnit }
      : null,
    cancellation: {
      rules: cancellationRules.map(({ heading, comparison, amount, unit, refundPercentage }) => ({
        heading: heading.trim(),
        comparison,
        amount: Number(amount),
        unit,
        refundPercentage: Number(refundPercentage),
      })),
    },
  };
};

/**
 * The EditListingPoliciesPanel component: the provider's rescheduling and cancellation policies.
 * They're shown on the listing page and copied to each booking when it's made.
 *
 * @component
 * @param {Object} props
 * @param {string} [props.className]
 * @param {string} [props.rootClassName]
 * @param {propTypes.ownListing} props.listing
 * @param {boolean} props.disabled
 * @param {boolean} props.ready
 * @param {Function} props.onSubmit
 * @param {string} props.submitButtonText
 * @param {boolean} props.panelUpdated
 * @param {boolean} props.updateInProgress
 * @param {Object} props.errors
 * @returns {JSX.Element}
 */
const EditListingPoliciesPanel = props => {
  const {
    className,
    rootClassName,
    listing,
    disabled,
    ready,
    onSubmit,
    submitButtonText,
    panelUpdated,
    updateInProgress,
    errors,
    updatePageTitle: UpdatePageTitle,
    intl,
  } = props;

  const classes = classNames(rootClassName || css.root, className);
  const isPublished = listing?.id && listing?.attributes?.state !== LISTING_STATE_DRAFT;
  const panelHeadingProps = isPublished
    ? {
        id: 'EditListingPoliciesPanel.title',
        values: { listingTitle: <ListingLink listing={listing} />, lineBreak: <br /> },
        messageProps: { listingTitle: listing.attributes.title },
      }
    : {
        id: 'EditListingPoliciesPanel.createListingTitle',
        values: { lineBreak: <br /> },
        messageProps: {},
      };

  return (
    <main className={classes}>
      <UpdatePageTitle
        panelHeading={intl.formatMessage(
          { id: panelHeadingProps.id },
          { ...panelHeadingProps.messageProps }
        )}
      />
      <H3 as="h1">
        <FormattedMessage id={panelHeadingProps.id} values={{ ...panelHeadingProps.values }} />
      </H3>
      <EditListingPoliciesForm
        className={css.form}
        initialValues={getInitialValues(listing)}
        onSubmit={values => onSubmit({ publicData: { policies: toPolicies(values) } })}
        saveActionMsg={submitButtonText}
        disabled={disabled}
        ready={ready}
        updated={panelUpdated}
        updateInProgress={updateInProgress}
        fetchErrors={errors}
      />
    </main>
  );
};

export default EditListingPoliciesPanel;
