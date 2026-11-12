import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Field } from 'react-final-form';
import loadable from '@loadable/component';
import classNames from 'classnames';

import { FormattedMessage, useIntl } from '../../../util/reactIntl';

import { IconSpinner, Modal, PrimaryButton, ValidationError } from '../../../components';

import { H1 } from '../../PageBuilder/Primitives/Heading';

import css from './StudioTermsField.module.css';

const SectionBuilder = loadable(
  () => import(/* webpackChunkName: "SectionBuilder" */ '../../PageBuilder/PageBuilder'),
  {
    resolveComponent: components => components.SectionBuilder,
  }
);

export const STUDIO_TERMS_FIELD_NAME = 'studioTermsAccepted';
const KEY_CODE_ENTER = 13;
// How close to the end counts as "read to the end" (pixels)
const END_TOLERANCE = 12;

// The studio terms page from Console, like the Terms of Service in their modal
const StudioTermsContent = props => {
  const { data, inProgress, error } = props;
  if (inProgress && !data) {
    return (
      <div className={css.loading}>
        <IconSpinner />
      </div>
    );
  }
  if (error || !data) {
    return (
      <p className={css.error}>
        <FormattedMessage id="StudioTermsField.loadError" />
      </p>
    );
  }
  const CustomHeading1 = headingProps => <H1 as="h2" {...headingProps} />;
  const exposeContentAsChildren = fieldData =>
    typeof fieldData?.content === 'string' ? { children: fieldData.content } : {};
  return (
    <SectionBuilder
      {...data}
      options={{
        fieldComponents: {
          heading1: { component: CustomHeading1, pickValidProps: exposeContentAsChildren },
        },
        isInsideContainer: true,
      }}
    />
  );
};

/**
 * Studio (provider) terms at signup: a required checkbox. Ticking it (or clicking the link)
 * opens the terms from Console in a modal. The Agree button is enabled only after the terms
 * have been scrolled to the end, and agreeing closes the modal and ticks the checkbox.
 *
 * @component
 * @param {Object} props
 * @param {string} props.formId
 * @param {Object|null} props.data Studio terms page data (sections)
 * @param {boolean} props.inProgress
 * @param {Object|null} props.error
 * @param {Function} props.onManageDisableScrolling
 * @returns {JSX.Element}
 */
const StudioTermsField = props => {
  const intl = useIntl();
  const { formId, data, inProgress, error, onManageDisableScrolling } = props;
  const [isOpen, setOpen] = useState(false);
  const [hasReadToEnd, setReadToEnd] = useState(false);
  const scrollRef = useRef(null);
  const id = `${formId || 'signup'}.studio-terms`;
  const canAgree = hasReadToEnd && !!data && !error;

  const checkReadToEnd = useCallback(() => {
    const element = scrollRef.current;
    if (element) {
      const { scrollTop, clientHeight, scrollHeight } = element;
      if (scrollTop + clientHeight >= scrollHeight - END_TOLERANCE) {
        setReadToEnd(true);
      }
    }
  }, []);

  // Short terms that fit without scrolling count as read; recheck when the content loads
  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    const timer = setTimeout(checkReadToEnd, 300);
    const element = scrollRef.current;
    const observer =
      element && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(checkReadToEnd) : null;
    if (observer) {
      observer.observe(element);
      if (element.firstElementChild) {
        observer.observe(element.firstElementChild);
      }
    }
    return () => {
      clearTimeout(timer);
      observer?.disconnect();
    };
  }, [isOpen, data, checkReadToEnd]);

  return (
    <Field
      name={STUDIO_TERMS_FIELD_NAME}
      validate={value =>
        value === true ? undefined : intl.formatMessage({ id: 'StudioTermsField.required' })
      }
    >
      {({ input, meta }) => {
        const open = () => {
          setOpen(true);
          input.onFocus();
        };
        const close = () => {
          setOpen(false);
          input.onBlur();
        };
        const onCheckboxClick = e => {
          // Ticking the box opens the terms: it's ticked when they're accepted there
          if (!input.value) {
            e.preventDefault();
            open();
          } else {
            input.onChange(false);
          }
        };
        const termsLink = (
          <span
            className={css.link}
            role="button"
            tabIndex="0"
            onClick={e => {
              e.preventDefault();
              open();
            }}
            onKeyUp={e => (e.keyCode === KEY_CODE_ENTER ? open() : null)}
          >
            <FormattedMessage id="StudioTermsField.linkText" />
          </span>
        );

        return (
          <div className={css.root}>
            <div className={css.checkboxRow}>
              <input
                id={id}
                className={css.checkbox}
                type="checkbox"
                checked={input.value === true}
                onChange={() => {}}
                onClick={onCheckboxClick}
                aria-describedby={meta.touched && meta.error ? `${id}-error` : undefined}
              />
              <label className={css.label} htmlFor={id} onClick={e => e.preventDefault()}>
                <FormattedMessage id="StudioTermsField.acceptText" values={{ termsLink }} />
              </label>
            </div>
            <ValidationError fieldMeta={meta} />

            <Modal
              id={`${id}.modal`}
              isOpen={isOpen}
              onClose={close}
              usePortal
              onManageDisableScrolling={onManageDisableScrolling}
              containerClassName={css.modalContainer}
            >
              <div className={css.modalContent}>
                <div className={css.scrollArea} ref={scrollRef} onScroll={checkReadToEnd}>
                  <div>
                    <StudioTermsContent data={data} inProgress={inProgress} error={error} />
                  </div>
                </div>
                <div className={css.modalFooter}>
                  <p className={classNames(css.hint, { [css.hintDone]: canAgree })}>
                    <FormattedMessage
                      id={canAgree ? 'StudioTermsField.readDone' : 'StudioTermsField.scrollHint'}
                    />
                  </p>
                  <PrimaryButton
                    className={css.agreeButton}
                    type="button"
                    disabled={!canAgree}
                    onClick={() => {
                      input.onChange(true);
                      close();
                    }}
                  >
                    <FormattedMessage id="StudioTermsField.agree" />
                  </PrimaryButton>
                </div>
              </div>
            </Modal>
          </div>
        );
      }}
    </Field>
  );
};

export default StudioTermsField;
