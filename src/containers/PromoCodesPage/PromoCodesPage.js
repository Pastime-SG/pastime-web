import React, { useState } from 'react';
import { shallowEqual, useDispatch, useSelector } from 'react-redux';
import classNames from 'classnames';

import { useConfiguration } from '../../context/configurationContext';
import { FormattedMessage, useIntl } from '../../util/reactIntl';
import { formatMoney } from '../../util/currency';
import { types as sdkTypes } from '../../util/sdkLoader';
import { showCreateListingLinkForUser } from '../../util/userHelpers';
import { isScrollingDisabled, manageDisableScrolling } from '../../ducks/ui.duck';

import {
  H3,
  IconSpinner,
  InlineTextButton,
  LayoutSingleColumn,
  Modal,
  NamedLink,
  Page,
  PrimaryButton,
  UserNav,
} from '../../components';

import TopbarContainer from '../../containers/TopbarContainer/TopbarContainer';
import FooterContainer from '../../containers/FooterContainer/FooterContainer';

import PromoCodeForm, { DISCOUNT_FIXED, DISCOUNT_PERCENTAGE } from './PromoCodeForm/PromoCodeForm';
import {
  clearSaveError,
  createPromoCodeThunk,
  deletePromoCodeThunk,
  fetchPromoCodeLedgerThunk,
  fetchPromoCodesThunk,
  ADMIN_TAB_MARKETPLACE,
  ADMIN_TAB_STUDIOS,
  switchAdminTab,
  switchView,
  updateLoyaltySettingsThunk,
  updatePromoCodeSettingsThunk,
  updatePromoCodeThunk,
} from './PromoCodesPage.duck';

import css from './PromoCodesPage.module.css';

const { Money } = sdkTypes;

const STATUS_ACTIVE = 'active';
const STATUS_INACTIVE = 'inactive';
const STATUS_EXPIRED = 'expired';
const STATUS_USED_UP = 'usedUp';

const ERROR_MESSAGE_IDS = {
  'code-exists': 'PromoCodesPage.error.codeExists',
  'code-in-use': 'PromoCodesPage.error.codeInUse',
  'invalid-code': 'PromoCodeForm.codeInvalid',
  'invalid-expiry': 'PromoCodesPage.error.invalidExpiry',
  'max-uses-below-uses': 'PromoCodesPage.error.maxUsesBelowUses',
  'too-many-requests': 'PromoCodesPage.error.tooManyRequests',
  'merchant-codes-disabled': 'PromoCodesPage.error.merchantCodesDisabled',
};

// Why the codes couldn't be loaded, from the response status (none: the server wasn't reached)
const getFetchErrorId = (error, isAdminView) => {
  const status = error?.status;
  if (!status) {
    return 'PromoCodesPage.error.fetchNetwork';
  }
  if (status === 401) {
    return 'PromoCodesPage.error.fetchSignedOut';
  }
  if (status === 403) {
    return isAdminView
      ? 'PromoCodesPage.error.fetchNotAdmin'
      : 'PromoCodesPage.error.fetchForbidden';
  }
  if (status === 429) {
    return 'PromoCodesPage.error.tooManyRequests';
  }
  return isAdminView ? 'PromoCodesPage.error.fetchAdmin' : 'PromoCodesPage.error.fetch';
};

const getErrorMessage = (intl, error) =>
  error
    ? intl.formatMessage({ id: ERROR_MESSAGE_IDS[error.code] || 'PromoCodesPage.error.generic' })
    : null;

/**
 * Status of a promo code: active, inactive (turned off by the merchant), expired or used up.
 *
 * @param {Object} promoCode
 * @param {Date} [now]
 * @returns {string}
 */
export const getPromoCodeStatus = (promoCode, now = new Date()) => {
  const { active, expiresAt, maxUses, usesCount } = promoCode;
  if (!active) {
    return STATUS_INACTIVE;
  }
  if (expiresAt && expiresAt <= now.getTime()) {
    return STATUS_EXPIRED;
  }
  if (maxUses != null && usesCount >= maxUses) {
    return STATUS_USED_UP;
  }
  return STATUS_ACTIVE;
};

// "2026-11-30" (the date input's value) <=> end of that day in the browser's time zone
const toDateInputValue = millis => {
  if (!millis) {
    return '';
  }
  const date = new Date(millis);
  const pad = n => `${n}`.padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const fromDateInputValue = value => {
  if (!value) {
    return null;
  }
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day, 23, 59, 59);
};

const getInitialValues = (promoCode, currency) =>
  promoCode
    ? {
        code: promoCode.code,
        discountType: promoCode.discountType,
        percentage: promoCode.percentage != null ? `${promoCode.percentage}` : '',
        amount:
          promoCode.amount != null
            ? new Money(promoCode.amount, promoCode.currency || currency)
            : null,
        maxUses: promoCode.maxUses != null ? `${promoCode.maxUses}` : '',
        expiresOn: toDateInputValue(promoCode.expiresAt),
      }
    : { discountType: DISCOUNT_PERCENTAGE, maxUses: '', expiresOn: '' };

// Form values => the API's promo code values
const toPromoCodeValues = (values, active) => {
  const { code, discountType, percentage, amount, maxUses, expiresOn } = values;
  const discount =
    discountType === DISCOUNT_FIXED
      ? { discountType, amount: amount?.amount, currency: amount?.currency }
      : { discountType, percentage: Number(percentage) };
  return {
    code: (code || '').trim().toUpperCase(),
    ...discount,
    maxUses: maxUses === '' || maxUses == null ? null : Number(maxUses),
    expiresAt: fromDateInputValue(expiresOn),
    active,
  };
};

// The API's values of an existing code, with a new status
const withActive = (promoCode, active) => ({
  discountType: promoCode.discountType,
  percentage: promoCode.percentage,
  amount: promoCode.amount,
  currency: promoCode.currency,
  maxUses: promoCode.maxUses,
  expiresAt:
    promoCode.expiresAt && promoCode.expiresAt > Date.now() ? new Date(promoCode.expiresAt) : null,
  active,
});

// Why a use was returned: the state the booking ended in
const RETURN_REASONS = {
  'state/declined': 'declined',
  'state/expired': 'expired',
  'state/payment-expired': 'paymentExpired',
};
const getReturnReason = transactionState => RETURN_REASONS[transactionState] || 'cancelled';

// The code's history: uses, and uses returned when the booking didn't go ahead
const PromoCodeLedger = props => {
  const intl = useIntl();
  const { ledgerState, showBookingLinks } = props;
  const { ledger = [], inProgress, error } = ledgerState || {};
  if (inProgress && ledger.length === 0) {
    return (
      <div className={css.ledger}>
        <IconSpinner className={css.spinner} />
      </div>
    );
  }
  if (error) {
    return (
      <p className={classNames(css.ledger, css.rowError)}>
        <FormattedMessage id="PromoCodesPage.ledgerError" />
      </p>
    );
  }
  if (ledger.length === 0) {
    return (
      <p className={classNames(css.ledger, css.ledgerEmpty)}>
        <FormattedMessage id="PromoCodesPage.ledgerEmpty" />
      </p>
    );
  }
  return (
    <ul className={css.ledger}>
      {ledger.map(entry => {
        const isReturned = entry.type === 'returned';
        const amount =
          entry.discount != null && entry.currency
            ? formatMoney(intl, new Money(entry.discount, entry.currency))
            : null;
        return (
          <li key={entry.id} className={css.ledgerEntry}>
            <span className={css.ledgerDate}>
              {entry.createdAt
                ? intl.formatDate(entry.createdAt, {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })
                : null}
            </span>
            <span className={classNames(css.ledgerType, css[`ledgerType_${entry.type}`])}>
              <FormattedMessage id={`PromoCodesPage.ledger.${entry.type}`} />
            </span>
            <span className={css.ledgerDetails}>
              {isReturned ? (
                <FormattedMessage
                  id={`PromoCodesPage.ledger.reason.${getReturnReason(entry.transactionState)}`}
                />
              ) : amount ? (
                <FormattedMessage id="PromoCodesPage.ledger.discount" values={{ amount }} />
              ) : null}
            </span>
            {showBookingLinks && entry.transactionId ? (
              <NamedLink
                className={css.ledgerLink}
                name="SaleDetailsPage"
                params={{ id: entry.transactionId }}
              >
                <FormattedMessage id="PromoCodesPage.viewBooking" />
              </NamedLink>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
};

const PromoCodeRow = props => {
  const intl = useIntl();
  const {
    promoCode,
    onEdit,
    onToggleActive,
    onDelete,
    onLoadLedger,
    ledgerState,
    showBookingLinks,
    showStudio,
    inProgress,
    errorMessage,
  } = props;
  const [isConfirmingDelete, setConfirmingDelete] = useState(false);
  const [showLedger, setShowLedger] = useState(false);
  const toggleLedger = () => {
    // The history is fetched when it's opened (and again when it's opened later)
    if (!showLedger) {
      onLoadLedger(promoCode);
    }
    setShowLedger(!showLedger);
  };
  const {
    code,
    discountType,
    percentage,
    amount,
    currency,
    maxUses,
    usesCount,
    expiresAt,
  } = promoCode;
  const status = getPromoCodeStatus(promoCode);
  const isUsed = usesCount > 0;

  const discount =
    discountType === DISCOUNT_PERCENTAGE
      ? intl.formatMessage({ id: 'PromoCodesPage.percentageOff' }, { percentage })
      : intl.formatMessage(
          { id: 'PromoCodesPage.amountOff' },
          { amount: formatMoney(intl, new Money(amount, currency)) }
        );

  return (
    <li className={css.rowWrapper}>
      <div className={css.row}>
        <div className={css.rowMain}>
          <div className={css.codeLine}>
            <span className={css.code}>{code}</span>
            <span className={classNames(css.status, css[`status_${status}`])}>
              <FormattedMessage id={`PromoCodesPage.status.${status}`} />
            </span>
          </div>
          <div className={css.details}>
            {showStudio ? (
              <span className={css.studio}>
                {promoCode.providerName || intl.formatMessage({ id: 'PromoCodesPage.studio' })}
              </span>
            ) : null}
            <span>{discount}</span>
            <span>
              {maxUses != null ? (
                <FormattedMessage
                  id="PromoCodesPage.usesWithLimit"
                  values={{ usesCount, maxUses }}
                />
              ) : (
                <FormattedMessage id="PromoCodesPage.uses" values={{ usesCount }} />
              )}
            </span>
            <span>
              {expiresAt ? (
                <FormattedMessage
                  id="PromoCodesPage.expires"
                  values={{
                    date: intl.formatDate(expiresAt, {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    }),
                  }}
                />
              ) : (
                <FormattedMessage id="PromoCodesPage.noExpiry" />
              )}
            </span>
          </div>
          {errorMessage ? (
            <p className={css.rowError} role="alert">
              {errorMessage}
            </p>
          ) : null}
          <InlineTextButton
            className={css.ledgerToggle}
            type="button"
            onClick={toggleLedger}
            aria-expanded={showLedger}
          >
            <FormattedMessage
              id={showLedger ? 'PromoCodesPage.hideLedger' : 'PromoCodesPage.viewLedger'}
            />
          </InlineTextButton>
        </div>

        <div className={css.actions}>
          {inProgress ? <IconSpinner className={css.spinner} /> : null}
          {isConfirmingDelete ? (
            <>
              <span className={css.confirmText}>
                <FormattedMessage id="PromoCodesPage.deleteConfirm" />
              </span>
              <InlineTextButton
                className={css.dangerAction}
                type="button"
                disabled={inProgress}
                onClick={() => onDelete(promoCode)}
              >
                <FormattedMessage id="PromoCodesPage.deleteYes" />
              </InlineTextButton>
              <InlineTextButton
                className={css.action}
                type="button"
                onClick={() => setConfirmingDelete(false)}
              >
                <FormattedMessage id="PromoCodesPage.deleteNo" />
              </InlineTextButton>
            </>
          ) : (
            <>
              {onEdit ? (
                <InlineTextButton
                  className={css.action}
                  type="button"
                  disabled={inProgress}
                  onClick={() => onEdit(promoCode)}
                >
                  <FormattedMessage id="PromoCodesPage.edit" />
                </InlineTextButton>
              ) : null}
              <InlineTextButton
                className={css.action}
                type="button"
                disabled={inProgress}
                onClick={() => onToggleActive(promoCode)}
              >
                <FormattedMessage
                  id={promoCode.active ? 'PromoCodesPage.deactivate' : 'PromoCodesPage.activate'}
                />
              </InlineTextButton>
              {/* Used codes are kept for the usage history: they can be deactivated instead */}
              {!isUsed ? (
                <InlineTextButton
                  className={css.dangerAction}
                  type="button"
                  disabled={inProgress}
                  onClick={() => setConfirmingDelete(true)}
                >
                  <FormattedMessage id="PromoCodesPage.delete" />
                </InlineTextButton>
              ) : null}
            </>
          )}
        </div>
      </div>
      {showLedger ? (
        <PromoCodeLedger ledgerState={ledgerState} showBookingLinks={showBookingLinks} />
      ) : null}
    </li>
  );
};

/**
 * The merchant's promo codes: create, edit, turn on or off, delete (if not used yet), and see
 * how many times each code has been used. Codes apply to all the merchant's listings.
 *
 * @component
 * @returns {JSX.Element}
 */
const PromoCodesPage = () => {
  const config = useConfiguration();
  const intl = useIntl();
  const dispatch = useDispatch();
  const [modalCode, setModalCode] = useState(null); // null: closed, {}: new code, or the code
  const currentUser = useSelector(state => state.user.currentUser);
  const scrollingDisabled = useSelector(state => isScrollingDisabled(state));
  const {
    promoCodes,
    fetchInProgress,
    fetchError,
    saveInProgress,
    saveError,
    actionInProgressId,
    actionError,
    ledgerByCode,
    isAdminView,
    loyaltyEnabled,
    loyaltyUpdateInProgress,
    loyaltyUpdateError,
    adminTab,
    merchantCodesEnabled,
    merchantCodesUpdateInProgress,
    merchantCodesUpdateError,
  } = useSelector(state => state.PromoCodesPage, shallowEqual);
  // Admins (profile.metadata.isAdmin, set by an operator) can switch to the marketplace's codes
  const isAdmin = currentUser?.attributes?.profile?.metadata?.isAdmin === true;
  const showAdminView = isAdmin && isAdminView;
  // Admin view: every studio's codes (see, turn on or off, delete unused ones; no creating or
  // editing a studio's discount)
  const isStudiosTab = showAdminView && adminTab === ADMIN_TAB_STUDIOS;
  // Studios: codes turned off by an admin
  const isMerchantCodesOff = !showAdminView && merchantCodesEnabled === false;

  const onManageDisableScrolling = (componentId, disableScrolling) =>
    dispatch(manageDisableScrolling(componentId, disableScrolling));
  const isEdit = !!modalCode?.id;
  const closeModal = () => {
    setModalCode(null);
    dispatch(clearSaveError());
  };

  const handleSubmit = values => {
    const promoCodeValues = toPromoCodeValues(values, isEdit ? modalCode.active : true);
    const action = isEdit
      ? updatePromoCodeThunk({ id: modalCode.id, values: promoCodeValues })
      : createPromoCodeThunk(promoCodeValues);
    return dispatch(action)
      .unwrap()
      .then(closeModal)
      .catch(() => {
        // The error is shown in the form
      });
  };

  const showManageListingsLink = showCreateListingLinkForUser(config, currentUser);
  const hasCodes = promoCodes.length > 0;

  return (
    <Page
      title={intl.formatMessage({ id: 'PromoCodesPage.title' })}
      scrollingDisabled={scrollingDisabled}
    >
      <LayoutSingleColumn
        topbar={
          <>
            <TopbarContainer />
            <UserNav currentPage="PromoCodesPage" showManageListingsLink={showManageListingsLink} />
          </>
        }
        footer={<FooterContainer />}
      >
        <div className={css.content}>
          <div className={css.header}>
            <div>
              <H3 as="h1" className={css.heading}>
                <FormattedMessage
                  id={
                    isStudiosTab
                      ? 'PromoCodesPage.studiosHeading'
                      : showAdminView
                      ? 'PromoCodesPage.adminHeading'
                      : 'PromoCodesPage.heading'
                  }
                />
              </H3>
              <p className={css.description}>
                <FormattedMessage
                  id={
                    isStudiosTab
                      ? 'PromoCodesPage.studiosDescription'
                      : showAdminView
                      ? 'PromoCodesPage.adminDescription'
                      : 'PromoCodesPage.description'
                  }
                />
              </p>
            </div>
            {!isStudiosTab && !isMerchantCodesOff ? (
              <PrimaryButton
                className={css.createButton}
                type="button"
                onClick={() => setModalCode({})}
              >
                <FormattedMessage id="PromoCodesPage.createButton" />
              </PrimaryButton>
            ) : null}
          </div>

          {showAdminView ? (
            <div className={css.tabs} role="tablist">
              {[ADMIN_TAB_MARKETPLACE, ADMIN_TAB_STUDIOS].map(tab => (
                <button
                  key={tab}
                  className={classNames(css.tab, { [css.tabSelected]: adminTab === tab })}
                  type="button"
                  role="tab"
                  aria-selected={adminTab === tab}
                  onClick={() => (adminTab === tab ? null : dispatch(switchAdminTab(tab)))}
                >
                  <FormattedMessage id={`PromoCodesPage.tab.${tab}`} />
                </button>
              ))}
            </div>
          ) : null}

          {isMerchantCodesOff ? (
            <p className={css.offNotice} role="status">
              <FormattedMessage id="PromoCodesPage.merchantCodesOff" />
            </p>
          ) : null}

          {isStudiosTab && merchantCodesEnabled !== null ? (
            <section className={css.loyaltyCard}>
              <div>
                <h2 className={css.loyaltyTitle}>
                  <FormattedMessage id="PromoCodesPage.merchantCodesTitle" />
                </h2>
                <p className={css.loyaltyText}>
                  <FormattedMessage
                    id={
                      merchantCodesEnabled
                        ? 'PromoCodesPage.merchantCodesOn'
                        : 'PromoCodesPage.merchantCodesOffAdmin'
                    }
                  />
                </p>
                {merchantCodesUpdateError ? (
                  <p className={css.rowError}>
                    <FormattedMessage id="PromoCodesPage.error.generic" />
                  </p>
                ) : null}
              </div>
              <button
                className={classNames(css.switch, { [css.switchOn]: merchantCodesEnabled })}
                type="button"
                role="switch"
                aria-checked={merchantCodesEnabled}
                aria-label={intl.formatMessage({ id: 'PromoCodesPage.merchantCodesTitle' })}
                disabled={merchantCodesUpdateInProgress}
                onClick={() => dispatch(updatePromoCodeSettingsThunk(!merchantCodesEnabled))}
              >
                <span className={css.switchKnob} />
              </button>
            </section>
          ) : null}

          {showAdminView && !isStudiosTab && loyaltyEnabled !== null ? (
            <section className={css.loyaltyCard}>
              <div>
                <h2 className={css.loyaltyTitle}>
                  <FormattedMessage id="PromoCodesPage.loyaltyTitle" />
                </h2>
                <p className={css.loyaltyText}>
                  <FormattedMessage
                    id={loyaltyEnabled ? 'PromoCodesPage.loyaltyOn' : 'PromoCodesPage.loyaltyOff'}
                  />
                </p>
                {loyaltyUpdateError ? (
                  <p className={css.rowError}>
                    <FormattedMessage id="PromoCodesPage.error.generic" />
                  </p>
                ) : null}
              </div>
              <button
                className={classNames(css.switch, { [css.switchOn]: loyaltyEnabled })}
                type="button"
                role="switch"
                aria-checked={loyaltyEnabled}
                aria-label={intl.formatMessage({ id: 'PromoCodesPage.loyaltyTitle' })}
                disabled={loyaltyUpdateInProgress}
                onClick={() => dispatch(updateLoyaltySettingsThunk(!loyaltyEnabled))}
              >
                <span className={css.switchKnob} />
              </button>
            </section>
          ) : null}

          {fetchInProgress ? (
            <div className={css.loading}>
              <IconSpinner />
            </div>
          ) : fetchError ? (
            <div className={css.error} role="alert">
              <p className={css.errorText}>
                <FormattedMessage id={getFetchErrorId(fetchError, showAdminView)} />
              </p>
              <InlineTextButton
                className={css.action}
                type="button"
                onClick={() => dispatch(fetchPromoCodesThunk())}
              >
                <FormattedMessage id="PromoCodesPage.tryAgain" />
              </InlineTextButton>
            </div>
          ) : hasCodes ? (
            <ul className={css.list}>
              {promoCodes.map(promoCode => (
                <PromoCodeRow
                  key={promoCode.id}
                  promoCode={promoCode}
                  onEdit={isStudiosTab ? null : setModalCode}
                  onToggleActive={code =>
                    dispatch(
                      updatePromoCodeThunk({ id: code.id, values: withActive(code, !code.active) })
                    )
                  }
                  onDelete={code => dispatch(deletePromoCodeThunk(code.id))}
                  onLoadLedger={code => dispatch(fetchPromoCodeLedgerThunk(code.id))}
                  ledgerState={ledgerByCode?.[promoCode.id]}
                  showBookingLinks={!showAdminView}
                  showStudio={isStudiosTab}
                  inProgress={actionInProgressId === promoCode.id}
                  errorMessage={
                    actionError?.id === promoCode.id && !modalCode
                      ? getErrorMessage(intl, actionError)
                      : null
                  }
                />
              ))}
            </ul>
          ) : (
            <p className={css.empty}>
              <FormattedMessage
                id={isStudiosTab ? 'PromoCodesPage.studiosEmpty' : 'PromoCodesPage.empty'}
              />
            </p>
          )}
        </div>

        {isAdmin ? (
          <button
            className={css.viewSwitch}
            type="button"
            onClick={() => dispatch(switchView(!isAdminView))}
          >
            <FormattedMessage
              id={isAdminView ? 'PromoCodesPage.switchToMerchant' : 'PromoCodesPage.switchToAdmin'}
            />
          </button>
        ) : null}

        <Modal
          id="PromoCodesPage.modal"
          containerClassName={css.modalContainer}
          isOpen={!!modalCode}
          onClose={closeModal}
          onManageDisableScrolling={onManageDisableScrolling}
          usePortal
        >
          {modalCode ? (
            <>
              <H3 as="h2" className={css.modalTitle}>
                <FormattedMessage
                  id={isEdit ? 'PromoCodesPage.editTitle' : 'PromoCodesPage.createTitle'}
                />
              </H3>
              <PromoCodeForm
                formId="PromoCodeForm"
                initialValues={getInitialValues(isEdit ? modalCode : null, config.currency)}
                onSubmit={handleSubmit}
                isEdit={isEdit}
                isUsed={modalCode.usesCount > 0}
                marketplaceCurrency={config.currency}
                inProgress={saveInProgress}
                errorMessage={getErrorMessage(intl, saveError)}
              />
            </>
          ) : null}
        </Modal>
      </LayoutSingleColumn>
    </Page>
  );
};

export default PromoCodesPage;
