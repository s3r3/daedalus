import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Slide } from '../Slide';

describe('Slide', () => {
  it('renders children', () => {
    render(<Slide><p>Hello</p></Slide>);
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('applies center layout classes', () => {
    const { container } = render(<Slide layout="center"><p>Test</p></Slide>);
    const div = container.firstElementChild!;
    expect(div.className).toContain('items-center');
    expect(div.className).toContain('justify-center');
    expect(div.className).toContain('text-center');
  });

  it('renders mesh background when bg="mesh"', () => {
    const { container } = render(<Slide bg="mesh"><p>Test</p></Slide>);
    const meshDiv = container.querySelector('.pointer-events-none');
    expect(meshDiv).toBeInTheDocument();
  });

  it('does not render mesh background by default', () => {
    const { container } = render(<Slide><p>Test</p></Slide>);
    const meshDiv = container.querySelector('.pointer-events-none');
    expect(meshDiv).toBeNull();
  });
});
