import React from 'react';
import '@testing-library/jest-dom';

import { renderWithProviders as render, testingLibrary } from '../../util/testHelpers';
import { useActiveCategoryIds } from '../../util/listingCategories';

import FilterComponent from './FilterComponent';

jest.mock('../../util/listingCategories', () => ({ useActiveCategoryIds: jest.fn() }));

const { screen } = testingLibrary;

const listingCategories = [
  { id: 'painting', name: 'Painting' },
  { id: 'pottery', name: 'Pottery' },
  { id: 'tufting', name: 'Tufting' },
];

const renderCategoryFilter = (initialValues = {}) =>
  render(
    <FilterComponent
      config={{
        key: 'categoryLevel',
        schemaType: 'category',
        scope: 'public',
        isNestedEnum: true,
        nestedParams: ['categoryLevel1'],
      }}
      initialValues={() => initialValues}
      getHandleChangedValueFn={() => () => null}
      listingCategories={listingCategories}
      marketplaceCurrency="SGD"
      intl={{ formatMessage: ({ id }) => id }}
      id="SearchFilters.categoryLevel"
      showAsPopup={false}
      liveEdit
    />
  );

describe('FilterComponent category filter', () => {
  it('shows every category until the active ones are known', () => {
    useActiveCategoryIds.mockReturnValue(null);
    renderCategoryFilter();
    expect(screen.getByText('Painting')).toBeInTheDocument();
    expect(screen.getByText('Pottery')).toBeInTheDocument();
    expect(screen.getByText('Tufting')).toBeInTheDocument();
  });

  it('shows only the categories with published listings', () => {
    useActiveCategoryIds.mockReturnValue(['pottery']);
    renderCategoryFilter();
    expect(screen.getByText('Pottery')).toBeInTheDocument();
    expect(screen.queryByText('Painting')).not.toBeInTheDocument();
    expect(screen.queryByText('Tufting')).not.toBeInTheDocument();
  });

  it('keeps the selected category even without listings', () => {
    useActiveCategoryIds.mockReturnValue(['pottery']);
    renderCategoryFilter({ pub_categoryLevel1: 'tufting' });
    expect(screen.getByText('Pottery')).toBeInTheDocument();
    expect(screen.getByText('Tufting')).toBeInTheDocument();
    expect(screen.queryByText('Painting')).not.toBeInTheDocument();
  });
});
