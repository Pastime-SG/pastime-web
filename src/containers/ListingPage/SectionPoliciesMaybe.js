import React from 'react';
import classNames from 'classnames';

import { FormattedMessage } from '../../util/reactIntl';
import { isBookingProcessAlias } from '../../transactions/transaction';

import { Heading, ListingPolicies } from '../../components';

import css from './ListingPage.module.css';

/**
 * The provider's cancellation and rescheduling policies on the listing page (booking listings).
 * The policies come with the listing's public data: nothing extra is fetched.
 *
 * @component
 * @param {Object} props
 * @param {string} [props.className]
 * @param {Object} props.publicData Listing's public data
 * @returns {JSX.Element|null}
 */
const SectionPoliciesMaybe = props => {
  const { className, publicData } = props;
  if (!isBookingProcessAlias(publicData?.transactionProcessAlias)) {
    return null;
  }

  return (
    <section className={classNames(css.sectionPolicies, className)} id="policies">
      <Heading as="h2" rootClassName={css.sectionHeadingWithExtraMargin}>
        <FormattedMessage id="ListingPage.policiesTitle" />
      </Heading>
      <ListingPolicies policies={publicData.policies} />
    </section>
  );
};

export default SectionPoliciesMaybe;
