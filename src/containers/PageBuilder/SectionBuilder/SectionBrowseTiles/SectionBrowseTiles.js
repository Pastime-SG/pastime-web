import React from 'react';
import classNames from 'classnames';

import { FormattedMessage } from '../../../../util/reactIntl';

import { pickFieldOptions } from '../../PageBuilder.helpers';
import Field, { hasDataInFields } from '../../Field';
import BlockBuilder, { BlockContainer } from '../../BlockBuilder';

import SectionContainer from '../SectionContainer';
import { getPlainText } from '../SectionBuilder.helpers';
import css from './SectionBrowseTiles.module.css';

// The Console section (anchor link ID) shown as browse tiles
export const BROWSE_TILES_SECTION_ID = 'browse-category';

// Tiles are ~1/6 of the row on desktop (200-220px)
const RESPONSIVE_IMAGE_SIZES = '(max-width: 767px) 45vw, (max-width: 1023px) 30vw, 230px';

/**
 * A browse tile: the block's image on top, its title and text in the white part below.
 * The text is shown as one paragraph, cut to two lines. The block's link (call to action), if
 * any, is shown below.
 *
 * @component
 * @param {Object} props Block props from the BlockBuilder (see BlockDefault)
 * @returns {JSX.Element}
 */
const BrowseTile = props => {
  const { blockId, title, text, callToAction, media, responsiveImageSizes, options } = props;
  const hasMedia = hasDataInFields([media], options);
  const description = getPlainText(text);
  return (
    <BlockContainer id={blockId} className={css.tile}>
      <div className={css.tileMedia}>
        {hasMedia ? <Field data={media} sizes={responsiveImageSizes} options={options} /> : null}
      </div>
      <div className={css.tileBody}>
        <Field data={title} className={css.tileTitle} options={options} />
        {description ? <p className={css.tileText}>{description}</p> : null}
        <Field data={callToAction} className={css.tileLink} options={options} />
      </div>
    </BlockContainer>
  );
};

/**
 * The "Find your kind of hands-on" section of the landing page: the Console section's title,
 * description and blocks as a row of browse tiles (horizontally scrollable on small screens).
 * The content stays editable in Console.
 *
 * @component
 * @param {Object} props Section props from the SectionBuilder (see SectionCarousel)
 * @returns {JSX.Element}
 */
const SectionBrowseTiles = props => {
  const {
    sectionId,
    className,
    rootClassName,
    title,
    description,
    appearance,
    callToAction,
    blocks = [],
    options,
  } = props;

  // If external mapping has been included for fields
  const fieldOptions = pickFieldOptions(options);
  const blockOptions = {
    ...options,
    blockComponents: { defaultBlock: { component: BrowseTile } },
  };

  return (
    <SectionContainer
      id={sectionId}
      className={classNames(className, css.root)}
      rootClassName={rootClassName}
      appearance={appearance}
      options={fieldOptions}
    >
      <header className={css.header}>
        <p className={css.eyebrow}>
          <FormattedMessage id="SectionBrowseTiles.eyebrow" />
        </p>
        <Field data={title} className={css.title} options={fieldOptions} />
        <Field data={description} className={css.description} options={fieldOptions} />
        <Field data={callToAction} options={fieldOptions} />
      </header>
      {blocks.length > 0 ? (
        <div className={css.tiles}>
          <BlockBuilder
            blocks={blocks}
            sectionId={sectionId}
            responsiveImageSizes={RESPONSIVE_IMAGE_SIZES}
            options={blockOptions}
          />
        </div>
      ) : null}
    </SectionContainer>
  );
};

export default SectionBrowseTiles;
