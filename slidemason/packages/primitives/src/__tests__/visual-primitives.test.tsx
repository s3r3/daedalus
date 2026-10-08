import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Card } from '../Card';
import { GradientText } from '../GradientText';
import { GhostNumber } from '../GhostNumber';
import { Divider } from '../Divider';
import { Slide } from '../Slide';

describe('Card', () => {
  it('renders children', () => {
    render(<Slide><Card>Card content</Card></Slide>);
    expect(screen.getByText('Card content')).toBeInTheDocument();
  });
});

describe('GradientText', () => {
  it('renders gradient text', () => {
    render(<Slide><GradientText>Title</GradientText></Slide>);
    expect(screen.getByText('Title')).toBeInTheDocument();
  });
});

describe('GhostNumber', () => {
  it('renders the number', () => {
    render(<GhostNumber n={3} />);
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});

describe('Divider', () => {
  it('renders without crashing', () => {
    const { container } = render(<Slide><Divider /></Slide>);
    expect(container.firstElementChild).toBeInTheDocument();
  });
});
