import React, { useEffect, useState } from 'react';
import classNames from 'classnames';

import { useIntl } from '../../../../util/reactIntl';

import { ResponsiveImage } from '../../../../components';

import { pickFieldOptions } from '../../PageBuilder.helpers';
import Field from '../../Field';
import { exposeImageProps } from '../../Field/Field.helpers';

import containerCss from '../SectionContainer/SectionContainer.module.css';
import heroCss from '../SectionHero/SectionHero.module.css';
import css from './SectionLandingHero.module.css';

// The Console section (anchor link ID) shown as the landing page hero with an image carousel
export const LANDING_HERO_SECTION_ID = 'landing-hero';

// Time each image is shown
const SLIDE_INTERVAL_MS = 3000;

const getVariantNames = image => Object.keys(image?.attributes?.variants || {});

/**
 * Background images: the blocks' images (Console). Without any, the section's own background
 * image is used.
 *
 * @param {Array<Object>} blocks
 * @param {Object} [appearance] Section's customAppearance field
 * @returns {Array<{image: Object, alt: string}>}
 */
const getSlides = (blocks, appearance) => {
  const blockImages = (blocks || [])
    .map(block => (block?.media?.fieldType === 'image' ? exposeImageProps(block.media) : {}))
    .filter(props => !!props.image);
  if (blockImages.length > 0) {
    return blockImages;
  }
  const backgroundImage = appearance?.backgroundImage
    ? exposeImageProps({ image: appearance.backgroundImage, alt: '' })
    : {};
  return backgroundImage.image ? [backgroundImage] : [];
};

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

/**
 * The landing page hero: the section's title, description and call to action (e.g. the search
 * bar) over a carousel of background images. The images are the section's blocks in Console:
 * they fade from one to the next. The first image loads with high priority (it's the largest
 * content of the page), the next one just before it's shown.
 *
 * The text looks the same as in the hero sections (SectionHero).
 *
 * @component
 * @param {Object} props Section props from the SectionBuilder (a columns section in Console)
 * @returns {JSX.Element}
 */
const SectionLandingHero = props => {
  const intl = useIntl();
  const {
    sectionId,
    className,
    rootClassName,
    defaultClasses,
    title,
    description,
    appearance,
    callToAction,
    blocks = [],
    options,
  } = props;
  const fieldOptions = pickFieldOptions(options);
  const slides = getSlides(blocks, appearance);
  const slideCount = slides.length;

  const [activeIndex, setActiveIndex] = useState(0);
  // Images are loaded when they're about to be shown: the active one and the next one
  const [loadedCount, setLoadedCount] = useState(Math.min(slideCount, 2));
  const [isPaused, setPaused] = useState(false);

  useEffect(() => {
    if (slideCount < 2 || isPaused || prefersReducedMotion()) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setActiveIndex(index => (index + 1) % slideCount);
    }, SLIDE_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [activeIndex, slideCount, isPaused]);

  useEffect(() => {
    setLoadedCount(count => Math.max(count, Math.min(slideCount, activeIndex + 2)));
  }, [activeIndex, slideCount]);

  // Overlay over the images for readable text, as set in Console (e.g. "Dark overlay")
  const { preset, color: overlayColor, opacity: overlayOpacity } =
    appearance?.backgroundImageOverlay || {};
  const hasOverlay = typeof preset === 'string' && preset !== 'none';
  const backgroundColor = appearance?.backgroundColor;

  return (
    // Own <section> (instead of SectionContainer): the images cover the whole section, not only
    // its padded content area
    <section
      id={sectionId}
      className={classNames(rootClassName || containerCss.root, className, heroCss.root, css.root)}
    >
      <div
        className={css.slides}
        style={backgroundColor ? { backgroundColor } : null}
        aria-hidden="true"
      >
        {slides.map((slide, index) => (
          <div
            key={index}
            className={classNames(css.slide, { [css.slideActive]: index === activeIndex })}
          >
            {index < loadedCount ? (
              <ResponsiveImage
                className={css.slideImage}
                alt={slide.alt}
                image={slide.image}
                variants={getVariantNames(slide.image)}
                sizes="100vw"
                {...(index === 0 ? { fetchpriority: 'high' } : { loading: 'lazy' })}
              />
            ) : null}
          </div>
        ))}
        {hasOverlay ? (
          <div
            className={css.overlay}
            style={{ backgroundColor: overlayColor, opacity: overlayOpacity }}
          />
        ) : null}
      </div>

      <header
        className={classNames(defaultClasses.sectionDetails, heroCss.heroDetails, css.content)}
      >
        <Field
          data={title}
          className={classNames(defaultClasses.title, heroCss.heroTitle)}
          options={fieldOptions}
        />
        <Field
          data={description}
          className={classNames(defaultClasses.description, heroCss.heroDescription)}
          options={fieldOptions}
        />
        <Field data={callToAction} className={defaultClasses.ctaButton} options={fieldOptions} />
      </header>

      {slideCount > 1 ? (
        <div
          className={css.dots}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          {slides.map((slide, index) => (
            <button
              key={index}
              type="button"
              className={classNames(css.dot, { [css.dotActive]: index === activeIndex })}
              aria-label={intl.formatMessage(
                { id: 'SectionLandingHero.showImage' },
                { number: index + 1, count: slideCount }
              )}
              aria-current={index === activeIndex}
              onClick={() => setActiveIndex(index)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
};

export default SectionLandingHero;
