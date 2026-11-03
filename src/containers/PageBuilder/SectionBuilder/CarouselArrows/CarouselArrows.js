import React, { useCallback, useEffect, useState } from 'react';
import classNames from 'classnames';

import { useIntl } from '../../../../util/reactIntl';

import css from './CarouselArrows.module.css';

/**
 * Scroll state of a horizontally scrolling element: whether it can scroll back or forward, and
 * functions to scroll it by most of its visible width.
 *
 * @param {HTMLElement|null} element The scrolling element (e.g. set with a callback ref)
 * @returns {{canPrev: boolean, canNext: boolean, scrollPrev: Function, scrollNext: Function}}
 */
export const useHorizontalScroll = element => {
  const [state, setState] = useState({ canPrev: false, canNext: false });

  useEffect(() => {
    if (!element) {
      return undefined;
    }
    const update = () => {
      const { scrollLeft, clientWidth, scrollWidth } = element;
      setState({ canPrev: scrollLeft > 4, canNext: scrollLeft + clientWidth < scrollWidth - 4 });
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    // Images and cards can change the width after the first render
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    resizeObserver?.observe(element);
    return () => {
      element.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      resizeObserver?.disconnect();
    };
  }, [element]);

  const scrollBy = useCallback(
    direction => {
      if (element) {
        element.scrollBy({ left: direction * element.clientWidth * 0.8, behavior: 'smooth' });
      }
    },
    [element]
  );

  return { ...state, scrollPrev: () => scrollBy(-1), scrollNext: () => scrollBy(1) };
};

/**
 * Previous and next buttons for a horizontally scrolling row (see useHorizontalScroll). Hidden
 * when everything fits, and on small screens, where the row is swiped.
 *
 * @component
 * @param {Object} props
 * @param {string} [props.className]
 * @param {boolean} props.canPrev
 * @param {boolean} props.canNext
 * @param {Function} props.onPrev
 * @param {Function} props.onNext
 * @returns {JSX.Element|null}
 */
const CarouselArrows = props => {
  const intl = useIntl();
  const { className, canPrev, canNext, onPrev, onNext } = props;
  if (!canPrev && !canNext) {
    return null;
  }
  return (
    <div className={classNames(css.root, className)}>
      <button
        className={css.arrow}
        type="button"
        onClick={onPrev}
        disabled={!canPrev}
        aria-label={intl.formatMessage({ id: 'CarouselArrows.previous' })}
      >
        <span aria-hidden="true">‹</span>
      </button>
      <button
        className={css.arrow}
        type="button"
        onClick={onNext}
        disabled={!canNext}
        aria-label={intl.formatMessage({ id: 'CarouselArrows.next' })}
      >
        <span aria-hidden="true">›</span>
      </button>
    </div>
  );
};

export default CarouselArrows;
