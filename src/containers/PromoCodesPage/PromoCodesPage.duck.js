import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

import { storableError } from '../../util/errors';
import {
  createPromoCode,
  deletePromoCode,
  fetchPromoCodeLedger,
  fetchPromoCodes,
  updatePromoCode,
} from '../../util/api';

// Errors keep the code from the server (e.g. 'code-exists'), so the page can explain them
const toError = e => ({ ...storableError(e), code: e?.code || null });

// Admin view: the marketplace's codes instead of the merchant's own (see PromoCodesPage)
const isAdminView = getState => !!getState().PromoCodesPage?.isAdminView;

// ================ Thunks ================ //

export const fetchPromoCodesThunk = createAsyncThunk(
  'PromoCodesPage/fetchPromoCodes',
  (_, { getState, rejectWithValue }) =>
    fetchPromoCodes(isAdminView(getState))
      .then(response => response.promoCodes)
      .catch(e => rejectWithValue(toError(e)))
);

export const createPromoCodeThunk = createAsyncThunk(
  'PromoCodesPage/createPromoCode',
  (values, { getState, rejectWithValue }) =>
    createPromoCode(values, isAdminView(getState))
      .then(response => response.promoCode)
      .catch(e => rejectWithValue(toError(e)))
);

export const updatePromoCodeThunk = createAsyncThunk(
  'PromoCodesPage/updatePromoCode',
  ({ id, values }, { getState, rejectWithValue }) =>
    updatePromoCode(id, values, isAdminView(getState))
      .then(response => response.promoCode)
      .catch(e => rejectWithValue({ ...toError(e), id }))
);

export const deletePromoCodeThunk = createAsyncThunk(
  'PromoCodesPage/deletePromoCode',
  (id, { getState, rejectWithValue }) =>
    deletePromoCode(id, isAdminView(getState))
      .then(() => id)
      .catch(e => rejectWithValue({ ...toError(e), id }))
);

// The code's history (uses and returned uses): fetched when the merchant opens it
export const fetchPromoCodeLedgerThunk = createAsyncThunk(
  'PromoCodesPage/fetchPromoCodeLedger',
  (id, { getState, rejectWithValue }) =>
    fetchPromoCodeLedger(id, isAdminView(getState))
      .then(response => ({ id, ledger: response.ledger }))
      .catch(e => rejectWithValue({ ...toError(e), id }))
);

// ================ Slice ================ //

const initialState = {
  isAdminView: false,
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
    setAdminView: (state, action) => ({ ...initialState, isAdminView: action.payload }),
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
 * Switch between the merchant's own codes and, for admins, the marketplace's codes. The server
 * checks that the user is an admin.
 *
 * @param {boolean} adminView
 * @returns {Function}
 */
export const switchView = adminView => dispatch => {
  dispatch(promoCodesPageSlice.actions.setAdminView(adminView));
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
  return dispatch(fetchPromoCodesThunk());
};
