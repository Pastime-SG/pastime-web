import React from 'react';
import classNames from 'classnames';

import { pickFieldOptions } from '../../PageBuilder.helpers';
import Field, { hasDataInFields } from '../../Field';
import { BlockContainer } from '../../BlockBuilder';

import SectionContainer from '../SectionContainer';
import { getPlainText } from '../SectionBuilder.helpers';
import css from './SectionHowItWorks.module.css';

// The Console section (anchor link ID) shown as numbered steps
export const HOW_IT_WORKS_SECTION_ID = 'how-it-works';

// The icon is shown small (36px)
const ICON_IMAGE_SIZES = '72px';

// 1 => "01"
const formatStepNumber = index => `${index + 1}`.padStart(2, '0');

/**
 * A step: the block's image as the icon, the step number (from the block's position), the
 * block's title and text.
 *
 * @component
 * @param {Object} props
 * @param {Object} props.block Block data from Console
 * @param {number} props.index Position of the block
 * @param {Object} props.options Field options
 * @returns {JSX.Element}
 */
const Step = props => {
  const { block, index, options } = props;
  const { blockId, title, text, media, callToAction } = block;
  const hasIcon = hasDataInFields([media], options);
  const description = getPlainText(text);
  return (
    <BlockContainer id={blockId} as="li" className={css.step}>
      <div className={css.icon}>
        {hasIcon ? <Field data={media} sizes={ICON_IMAGE_SIZES} options={options} /> : null}
      </div>
      <div className={css.stepBody}>
        <span className={css.stepNumber}>{formatStepNumber(index)}</span>
        <Field data={title} className={css.stepTitle} options={options} />
        {description ? <p className={css.stepText}>{description}</p> : null}
        <Field data={callToAction} className={css.stepLink} options={options} />
      </div>
    </BlockContainer>
  );
};

/**
 * The "How it works" section of the landing page: the Console section's title and blocks as
 * numbered steps. Each block's image is the step's icon. The content stays editable in Console.
 *
 * @component
 * @param {Object} props Section props from the SectionBuilder (see SectionColumns)
 * @returns {JSX.Element}
 */
const SectionHowItWorks = props => {
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

  return (
    <SectionContainer
      id={sectionId}
      className={classNames(className, css.root)}
      rootClassName={rootClassName}
      appearance={appearance}
      options={fieldOptions}
    >
      <div className={css.content}>
        <header className={css.header}>
          <Field data={title} className={css.title} options={fieldOptions} />
          <Field data={description} className={css.description} options={fieldOptions} />
          <Field data={callToAction} options={fieldOptions} />
        </header>
        {blocks.length > 0 ? (
          <ol className={css.steps}>
            {blocks.map((block, index) => (
              <Step
                key={block.blockId || index}
                block={block}
                index={index}
                options={fieldOptions}
              />
            ))}
          </ol>
        ) : null}
      </div>
    </SectionContainer>
  );
};

export default SectionHowItWorks;
