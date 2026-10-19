import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

import { storableError } from '../../util/errors';
import { fetchLoyalty } from '../../util/api';

// ================ Thunks ================ //

export const fetchLoyaltyThunk = createAsyncThunk(
  'LoyaltyPage/fetchLoyalty',
  (_, { rejectWithValue }) => fetchLoyalty().catch(e => rejectWithValue(storableError(e)))
);

// ================ Slice ================ //

const initialState = {
  account: null,
  ledger: [],
  fetchInProgress: false,
  fetchError: null,
};

const loyaltyPageSlice = createSlice({
  name: 'LoyaltyPage',
  initialState,
  reducers: {},
  extraReducers: builder => {
    builder
      .addCase(fetchLoyaltyThunk.pending, state => {
        state.fetchInProgress = true;
        state.fetchError = null;
      })
      .addCase(fetchLoyaltyThunk.fulfilled, (state, action) => {
        state.fetchInProgress = false;
        state.account = action.payload.account;
        state.ledger = action.payload.ledger || [];
      })
      .addCase(fetchLoyaltyThunk.rejected, (state, action) => {
        state.fetchInProgress = false;
        state.fetchError = action.payload;
      });
  },
});

export default loyaltyPageSlice.reducer;

// ================ Load data ================ //

/**
 * The credits come from the app's server with the signed-in user's session, so they're fetched
 * in the browser only (not during server-side rendering).
 *
 * @returns {Function}
 */
export const loadData = () => dispatch => {
  if (typeof window === 'undefined') {
    return Promise.resolve();
  }
  return dispatch(fetchLoyaltyThunk());
};
