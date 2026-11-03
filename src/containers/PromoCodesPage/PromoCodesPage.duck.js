import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

import { storableError } from '../../util/errors';
import {
  createPromoCode,
  deletePromoCode,
  fetchPromoCodeLedger,
  fetchPromoCodes,
  updatePromoCode,
  fetchLoyaltySettings,
  updateLoyaltySettings,
  fetchPromoCodeSettings,
  updatePromoCodeSettings,
} from '../../util/api';

// Errors keep the code from the server (e.g. 'code-exists'), so the page can explain them
const toError = e => ({ ...storableError(e), code: e?.code || null });

// Whose codes the page shows: the studio's own, or for admins (see PromoCodesPage) the
// marketplace's codes or every studio's codes
const getScope = getState => {
  const { isAdminView, adminTab } = getState().PromoCodesPage || {};
  return !isAdminView ? 'merchant' : adminTab === ADMIN_TAB_STUDIOS ? 'adminStudios' : 'admin';
};

export const ADMIN_TAB_MARKETPLACE = 'marketplace';
export const ADMIN_TAB_STUDIOS = 'studios';

// ================ Thunks ================ //

export const fetchPromoCodesThunk = createAsyncThunk(
  'PromoCodesPage/fetchPromoCodes',
  (_, { getState, rejectWithValue }) =>
    fetchPromoCodes(getScope(getState))
      .then(response => response.promoCodes)
      .catch(e => rejectWithValue(toError(e)))
);

export const createPromoCodeThunk = createAsyncThunk(
  'PromoCodesPage/createPromoCode',
  (values, { getState, rejectWithValue }) =>
    createPromoCode(values, getScope(getState))
      .then(response => response.promoCode)
      .catch(e => rejectWithValue(toError(e)))
);

export const updatePromoCodeThunk = createAsyncThunk(
  'PromoCodesPage/updatePromoCode',
  ({ id, values }, { getState, rejectWithValue }) =>
    updatePromoCode(id, values, getScope(getState))
      .then(response => response.promoCode)
      .catch(e => rejectWithValue({ ...toError(e), id }))
);

export const deletePromoCodeThunk = createAsyncThunk(
  'PromoCodesPage/deletePromoCode',
  (id, { getState, rejectWithValue }) =>
    deletePromoCode(id, getScope(getState))
      .then(() => id)
      .catch(e => rejectWithValue({ ...toError(e), id }))
);

// The code's history (uses and returned uses): fetched when the merchant opens it
export const fetchPromoCodeLedgerThunk = createAsyncThunk(
  'PromoCodesPage/fetchPromoCodeLedger',
  (id, { getState, rejectWithValue }) =>
    fetchPromoCodeLedger(id, getScope(getState))
      .then(response => ({ id, ledger: response.ledger }))
      .catch(e => rejectWithValue({ ...toError(e), id }))
);

// Admin view: the loyalty program's on/off switch
export const fetchLoyaltySettingsThunk = createAsyncThunk(
  'PromoCodesPage/fetchLoyaltySettings',
  (_, { rejectWithValue }) =>
    fetchLoyaltySettings()
      .then(response => response.enabled === true)
      .catch(e => rejectWithValue(toError(e)))
);

export const updateLoyaltySettingsThunk = createAsyncThunk(
  'PromoCodesPage/updateLoyaltySettings',
  (enabled, { rejectWithValue }) =>
    updateLoyaltySettings(enabled)
      .then(response => response.enabled === true)
      .catch(e => rejectWithValue(toError(e)))
);

// Whether studio codes are turned on: studios see a notice when they're off, admins a switch
export const fetchPromoCodeSettingsThunk = createAsyncThunk(
  'PromoCodesPage/fetchPromoCodeSettings',
  (_, { rejectWithValue }) =>
    fetchPromoCodeSettings()
      .then(response => response.merchantCodesEnabled !== false)
      .catch(e => rejectWithValue(toError(e)))
);

export const updatePromoCodeSettingsThunk = createAsyncThunk(
  'PromoCodesPage/updatePromoCodeSettings',
  (enabled, { rejectWithValue }) =>
    updatePromoCodeSettings(enabled)
      .then(response => response.merchantCodesEnabled !== false)
      .catch(e => rejectWithValue(toError(e)))
);

// ================ Slice ================ //

const initialState = {
  isAdminView: false,
  adminTab: ADMIN_TAB_MARKETPLACE,
  // Whether studio codes are turned on: null until fetched
  merchantCodesEnabled: null,
  merchantCodesUpdateInProgress: false,
  merchantCodesUpdateError: null,
  // Admin view: null until fetched
  loyaltyEnabled: null,
  loyaltyUpdateInProgress: false,
  loyaltyUpdateError: null,
  promoCodes: [],
  fetchInProgress: false,
  fetchError: null,
  saveInProgress: false,
  saveError: null,
  // Id of the code being changed (status or deletion) and its error
  actionInProgressId: null,
  actionError: null,
  // By promo code id: { ledger, inProgress, error }
  ledgerByCode: {},
};

const replaceCode = (promoCodes, promoCode) =>
  promoCodes.map(c => (c.id === promoCode.id ? promoCode : c));

const promoCodesPageSlice = createSlice({
  name: 'PromoCodesPage',
  initialState,
  reducers: {
    clearSaveError: state => {
      state.saveError = null;
    },
    setAdminView: (state, action) => ({
      ...initialState,
      merchantCodesEnabled: state.merchantCodesEnabled,
      isAdminView: action.payload,
    }),
    setAdminTab: (state, action) => ({
      ...initialState,
      merchantCodesEnabled: state.merchantCodesEnabled,
      loyaltyEnabled: state.loyaltyEnabled,
      isAdminView: true,
      adminTab: action.payload,
    }),
  },
  extraReducers: builder => {
    builder
      .addCase(fetchPromoCodesThunk.pending, state => {
        state.fetchInProgress = true;
        state.fetchError = null;
      })
      .addCase(fetchPromoCodesThunk.fulfilled, (state, action) => {
        state.fetchInProgress = false;
        state.promoCodes = action.payload;
      })
      .addCase(fetchPromoCodesThunk.rejected, (state, action) => {
        state.fetchInProgress = false;
        state.fetchError = action.payload;
      })
      .addCase(createPromoCodeThunk.pending, state => {
        state.saveInProgress = true;
        state.saveError = null;
      })
      .addCase(createPromoCodeThunk.fulfilled, (state, action) => {
        state.saveInProgress = false;
        state.promoCodes = [action.payload, ...state.promoCodes];
      })
      .addCase(createPromoCodeThunk.rejected, (state, action) => {
        state.saveInProgress = false;
        state.saveError = action.payload;
      })
      .addCase(updatePromoCodeThunk.pending, (state, action) => {
        state.saveInProgress = true;
        state.saveError = null;
        state.actionInProgressId = action.meta.arg.id;
        state.actionError = null;
      })
      .addCase(updatePromoCodeThunk.fulfilled, (state, action) => {
        state.saveInProgress = false;
        state.actionInProgressId = null;
        state.promoCodes = replaceCode(state.promoCodes, action.payload);
      })
      .addCase(updatePromoCodeThunk.rejected, (state, action) => {
        state.saveInProgress = false;
        state.actionInProgressId = null;
        state.saveError = action.payload;
        state.actionError = action.payload;
      })
      .addCase(fetchPromoCodeLedgerThunk.pending, (state, action) => {
        state.ledgerByCode[action.meta.arg] = {
          ...state.ledgerByCode[action.meta.arg],
          inProgress: true,
          error: null,
        };
      })
      .addCase(fetchPromoCodeLedgerThunk.fulfilled, (state, action) => {
        const { id, ledger } = action.payload;
        state.ledgerByCode[id] = { ledger, inProgress: false, error: null };
      })
      .addCase(fetchPromoCodeLedgerThunk.rejected, (state, action) => {
        state.ledgerByCode[action.meta.arg] = {
          ...state.ledgerByCode[action.meta.arg],
          inProgress: false,
          error: action.payload,
        };
      })
      .addCase(fetchPromoCodeSettingsThunk.fulfilled, (state, action) => {
        state.merchantCodesEnabled = action.payload;
      })
      .addCase(updatePromoCodeSettingsThunk.pending, state => {
        state.merchantCodesUpdateInProgress = true;
        state.merchantCodesUpdateError = null;
      })
      .addCase(updatePromoCodeSettingsThunk.fulfilled, (state, action) => {
        state.merchantCodesUpdateInProgress = false;
        state.merchantCodesEnabled = action.payload;
      })
      .addCase(updatePromoCodeSettingsThunk.rejected, (state, action) => {
        state.merchantCodesUpdateInProgress = false;
        state.merchantCodesUpdateError = action.payload;
      })
      .addCase(fetchLoyaltySettingsThunk.fulfilled, (state, action) => {
        state.loyaltyEnabled = action.payload;
      })
      .addCase(updateLoyaltySettingsThunk.pending, state => {
        state.loyaltyUpdateInProgress = true;
        state.loyaltyUpdateError = null;
      })
      .addCase(updateLoyaltySettingsThunk.fulfilled, (state, action) => {
        state.loyaltyUpdateInProgress = false;
        state.loyaltyEnabled = action.payload;
      })
      .addCase(updateLoyaltySettingsThunk.rejected, (state, action) => {
        state.loyaltyUpdateInProgress = false;
        state.loyaltyUpdateError = action.payload;
      })
      .addCase(deletePromoCodeThunk.pending, (state, action) => {
        state.actionInProgressId = action.meta.arg;
        state.actionError = null;
      })
      .addCase(deletePromoCodeThunk.fulfilled, (state, action) => {
        state.actionInProgressId = null;
        state.promoCodes = state.promoCodes.filter(c => c.id !== action.payload);
      })
      .addCase(deletePromoCodeThunk.rejected, (state, action) => {
        state.actionInProgressId = null;
        state.actionError = action.payload;
      });
  },
});

export const { clearSaveError } = promoCodesPageSlice.actions;

/**
 * Admin view: switch between the marketplace's codes and every studio's codes.
 *
 * @param {string} tab ADMIN_TAB_MARKETPLACE or ADMIN_TAB_STUDIOS
 * @returns {Function}
 */
export const switchAdminTab = tab => dispatch => {
  dispatch(promoCodesPageSlice.actions.setAdminTab(tab));
  return dispatch(fetchPromoCodesThunk());
};

/**
 * Switch between the merchant's own codes and, for admins, the marketplace's codes. The server
 * checks that the user is an admin.
 *
 * @param {boolean} adminView
 * @returns {Function}
 */
export const switchView = adminView => dispatch => {
  dispatch(promoCodesPageSlice.actions.setAdminView(adminView));
  if (adminView) {
    dispatch(fetchLoyaltySettingsThunk());
  }
  return dispatch(fetchPromoCodesThunk());
};

export default promoCodesPageSlice.reducer;

// ================ Load data ================ //

/**
 * The codes come from the app's own server with the signed-in user's session, so they're
 * fetched in the browser only (not during server-side rendering).
 *
 * @returns {Function}
 */
export const loadData = () => dispatch => {
  if (typeof window === 'undefined') {
    return Promise.resolve();
  }
  return Promise.all([dispatch(fetchPromoCodesThunk()), dispatch(fetchPromoCodeSettingsThunk())]);
};
