import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Heading } from '../Heading';
import { Text } from '../Text';
import { Badge } from '../Badge';
import { Slide } from '../Slide';

describe('Heading', () => {
  it('renders with default size', () => {
    render(<Slide><Heading>Test Heading</Heading></Slide>);
    expect(screen.getByText('Test Heading')).toBeInTheDocument();
  });

  it('renders as h1 for hero size', () => {
    render(<Slide><Heading size="hero">Hero</Heading></Slide>);
    const el = screen.getByText('Hero');
    expect(el.tagName).toBe('H1');
  });

  it('renders as h2 by default', () => {
    render(<Slide><Heading>Sub</Heading></Slide>);
    const el = screen.getByText('Sub');
    expect(el.tagName).toBe('H2');
  });
});

describe('Text', () => {
  it('renders paragraph text', () => {
    render(<Slide><Text>Hello world</Text></Slide>);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('renders as p tag', () => {
    render(<Slide><Text>Check tag</Text></Slide>);
    expect(screen.getByText('Check tag').tagName).toBe('P');
  });
});

describe('Badge', () => {
  it('renders badge text', () => {
    render(<Slide><Badge>Beta</Badge></Slide>);
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });
});
