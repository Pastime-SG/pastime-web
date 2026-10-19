import React from 'react';
import { shallowEqual, useSelector } from 'react-redux';
import classNames from 'classnames';

import { FormattedMessage, useIntl } from '../../util/reactIntl';
import { formatMoney } from '../../util/currency';
import { types as sdkTypes } from '../../util/sdkLoader';
import { isScrollingDisabled } from '../../ducks/ui.duck';

import { H3, IconSpinner, LayoutSingleColumn, NamedLink, Page } from '../../components';

import TopbarContainer from '../../containers/TopbarContainer/TopbarContainer';
import FooterContainer from '../../containers/FooterContainer/FooterContainer';

import css from './LoyaltyPage.module.css';

const { Money } = sdkTypes;

// Whole dollars of points, e.g. 1000 (minor units) => 10
const toWholeUnits = amount => Math.floor((amount || 0) / 100);

const CreditsSummary = props => {
  const intl = useIntl();
  const { account } = props;
  const { creditBalance, points, currency, spendPerCredit, creditPerSpend } = account;
  const formatAmount = amount => (currency ? formatMoney(intl, new Money(amount, currency)) : '');
  const progress = spendPerCredit ? Math.min(100, (points / spendPerCredit) * 100) : 0;

  return (
    <section className={css.summary}>
      <div>
        <p className={css.summaryLabel}>
          <FormattedMessage id="LoyaltyPage.balanceLabel" />
        </p>
        <p className={css.balance}>{formatAmount(creditBalance)}</p>
      </div>
      <div className={css.progressBlock}>
        <p className={css.progressText}>
          <FormattedMessage
            id="LoyaltyPage.progress"
            values={{
              points: toWholeUnits(points),
              target: toWholeUnits(spendPerCredit),
              credit: formatAmount(creditPerSpend),
            }}
          />
        </p>
        <div
          className={css.progressBar}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={toWholeUnits(spendPerCredit)}
          aria-valuenow={toWholeUnits(points)}
        >
          <div className={css.progressFill} style={{ width: `${progress}%` }} />
        </div>
      </div>
    </section>
  );
};

const LedgerEntry = props => {
  const intl = useIntl();
  const { entry } = props;
  const { type, amount, currency, transactionId, paidAmount, createdAt } = entry;
  const formatAmount = value => (currency ? formatMoney(intl, new Money(value, currency)) : '');
  const isMinus = type === 'spent';

  return (
    <li className={css.entry}>
      <span className={css.entryDate}>
        {createdAt
          ? intl.formatDate(createdAt, { day: 'numeric', month: 'short', year: 'numeric' })
          : null}
      </span>
      <span className={css.entryDetails}>
        <FormattedMessage
          id={`LoyaltyPage.entry.${type}`}
          values={{ paid: paidAmount != null ? formatAmount(paidAmount) : '' }}
        />
        {transactionId ? (
          <NamedLink
            className={css.entryLink}
            name="OrderDetailsPage"
            params={{ id: transactionId }}
          >
            <FormattedMessage id="LoyaltyPage.viewBooking" />
          </NamedLink>
        ) : null}
      </span>
      <span className={classNames(css.entryAmount, { [css.entryAmountMinus]: isMinus })}>
        {isMinus ? '−' : '+'}
        {formatAmount(amount)}
      </span>
    </li>
  );
};

/**
 * The customer's loyalty credits: the balance, the points towards the next credit, and the
 * history of credits earned, used and given back.
 *
 * @component
 * @returns {JSX.Element}
 */
const LoyaltyPage = () => {
  const intl = useIntl();
  const scrollingDisabled = useSelector(state => isScrollingDisabled(state));
  const { account, ledger, fetchInProgress, fetchError } = useSelector(
    state => state.LoyaltyPage,
    shallowEqual
  );

  return (
    <Page
      title={intl.formatMessage({ id: 'LoyaltyPage.title' })}
      scrollingDisabled={scrollingDisabled}
    >
      <LayoutSingleColumn topbar={<TopbarContainer />} footer={<FooterContainer />}>
        <div className={css.content}>
          <H3 as="h1" className={css.heading}>
            <FormattedMessage id="LoyaltyPage.heading" />
          </H3>
          <p className={css.description}>
            <FormattedMessage id="LoyaltyPage.description" />
          </p>

          {fetchInProgress && !account ? (
            <div className={css.loading}>
              <IconSpinner />
            </div>
          ) : fetchError ? (
            <p className={css.error}>
              <FormattedMessage id="LoyaltyPage.fetchError" />
            </p>
          ) : account ? (
            <>
              <CreditsSummary account={account} />
              <H3 as="h2" className={css.historyHeading}>
                <FormattedMessage id="LoyaltyPage.historyHeading" />
              </H3>
              {ledger.length > 0 ? (
                <ul className={css.ledger}>
                  {ledger.map(entry => (
                    <LedgerEntry key={entry.id} entry={entry} />
                  ))}
                </ul>
              ) : (
                <p className={css.empty}>
                  <FormattedMessage id="LoyaltyPage.historyEmpty" />
                </p>
              )}
            </>
          ) : null}
        </div>
      </LayoutSingleColumn>
    </Page>
  );
};

export default LoyaltyPage;
