// A select of the panel. A native select opens its list as a window of the system, which can go out of the DevTools panel: this
// list is part of the page, and always fits in the panel (above the button when there is more room there). It keeps the keyboard
// of a select: arrows, Home, End, Enter, Space, Escape, and the first letter of an option.
import { Fragment } from 'preact';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';

export interface SelectOption {
  value: string;
  label: string;
  /** Options with the same group follow a small title. */
  group?: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  id?: string;
  'aria-label'?: string;
  disabled?: boolean;
  class?: string;
}

/** Space between the list and the edges of the panel. */
const EDGE = 8;

export function Select({ value, options, onChange, id, 'aria-label': label, disabled, class: className }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const chosen = options.find((option) => option.value === value);

  const show = (): void => {
    if (disabled || options.length === 0) return;
    setActive(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  };
  const pick = (index: number): void => {
    const option = options[index];
    setOpen(false);
    button.current?.focus();
    if (option && option.value !== value) onChange(option.value);
  };

  // Place the list in the panel: under the button, or above it when there is more room there; never wider than the panel. A
  // scroll of the panel moves it with the button, and closes it when the button goes out of view.
  const placeList = (): void => {
    const box = list.current;
    const rect = button.current?.getBoundingClientRect();
    if (!box || !rect) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return setOpen(false);
    box.style.maxHeight = 'none';
    box.style.width = 'auto';
    const width = Math.min(Math.max(rect.width, box.scrollWidth + 2), window.innerWidth - 2 * EDGE);
    const left = Math.min(Math.max(EDGE, rect.left), window.innerWidth - EDGE - width);
    const below = window.innerHeight - rect.bottom - EDGE - 2;
    const above = rect.top - EDGE - 2;
    const wanted = box.scrollHeight + 2;
    const down = below >= wanted || below >= above;
    const height = Math.min(wanted, Math.max(60, down ? below : above));
    const top = down ? rect.bottom + 2 : rect.top - 2 - height;
    box.style.width = `${width}px`;
    box.style.maxHeight = `${height}px`;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    // A parent with a transform or a filter moves a fixed box: take off what it adds.
    const got = box.getBoundingClientRect();
    if (got.left !== left) box.style.left = `${2 * left - got.left}px`;
    if (got.top !== top) box.style.top = `${2 * top - got.top}px`;
  };
  useLayoutEffect(() => {
    if (open) placeList();
  }, [open, options.length]);

  // A click out of the select, a resize or a blur of the panel closes the list, as with a native select.
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event): void => {
      const target = event.target;
      if (target instanceof Node && (button.current?.contains(target) || list.current?.contains(target))) return;
      setOpen(false);
    };
    const scrolled = (event: Event): void => {
      if (!(event.target instanceof Node && list.current?.contains(event.target))) placeList();
    };
    const close = (): void => setOpen(false);
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [open]);

  // Keep the active option in view. Only the list scrolls: scrollIntoView could scroll the panel too, and that closes the list.
  useEffect(() => {
    const box = list.current;
    const item = box?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!open || !box || !item) return;
    if (item.offsetTop < box.scrollTop) box.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = item.offsetTop + item.offsetHeight - box.clientHeight;
  }, [open, active]);

  const onKeyDown = (event: KeyboardEvent): void => {
    const last = options.length - 1;
    const move = (to: number): void => {
      event.preventDefault();
      if (open) setActive(Math.min(last, Math.max(0, to)));
      else show();
    };
    if (event.key === 'ArrowDown') move(active + 1);
    else if (event.key === 'ArrowUp') move(active - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(last);
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) pick(active);
      else show();
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === 'Tab') setOpen(false);
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      // The next option that starts with this letter.
      const start = open ? active : Math.max(0, options.findIndex((option) => option.value === value));
      const letter = event.key.toLowerCase();
      for (let step = 1; step <= options.length; step++) {
        const index = (start + step) % options.length;
        if (options[index]?.label.toLowerCase().startsWith(letter)) {
          if (open) setActive(index);
          else if (options[index]) onChange(options[index].value);
          break;
        }
      }
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        id={id}
        class={className ? `select ${className}` : 'select'}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-label={label}
        data-value={value}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        {chosen?.label ?? ''}
      </button>
      {open && (
        // In a label, a click would also go to the button and open the list again: preventDefault stops that.
        <ul ref={list} id={listId} class="select-list" role="listbox" aria-label={label} onClick={(event) => event.preventDefault()}>
          {options.map((option, index) => (
            <Fragment key={option.value}>
              {option.group !== undefined && option.group !== options[index - 1]?.group ? (
                <li key={`group-${option.group}`} class="select-group" role="presentation">
                  {option.group}
                </li>
              ) : null}
              <li
                id={`${listId}-${index}`}
                role="option"
                data-index={index}
                data-value={option.value}
                aria-selected={option.value === value}
                class={index === active ? 'active' : undefined}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(index)}
              >
                {option.label}
              </li>
            </Fragment>
          ))}
        </ul>
      )}
    </>
  );
}
