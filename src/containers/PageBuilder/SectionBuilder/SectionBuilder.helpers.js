/**
 * Find the section that should treat its images as above-the-fold candidates.
 * Currently: the first section on the page.
 *
 * @param {Array<{ sectionId: string, sectionType: string }>} sections
 * @returns {string|null} sectionId of the priority section, or null
 */
export const getPrioritySectionId = sections => {
  return sections?.[0]?.sectionId || null;
};

/**
 * Text field content (markdown from Console) as one line of plain text: markdown syntax such as
 * **bold** is dropped. Used for short texts that are cut to a few lines.
 *
 * @param {Object} [textField] Field data, e.g. { fieldType: 'markdown', content: '...' }
 * @returns {string}
 */
export const getPlainText = textField =>
  typeof textField?.content === 'string'
    ? textField.content
        .replace(/[*_`#>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    : '';
