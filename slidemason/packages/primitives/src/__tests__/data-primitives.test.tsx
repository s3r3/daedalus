import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { IconCircle } from '../IconCircle';
import { StatBox } from '../StatBox';
import { Step } from '../Step';
import { Pipeline } from '../Pipeline';
import { Slide } from '../Slide';

afterEach(cleanup);

const MockIcon = ({ size, style }: { size?: number; style?: React.CSSProperties }) => (
  <svg data-testid="icon" width={size} height={size} style={style} />
);

describe('IconCircle', () => {
  it('renders the icon', () => {
    render(<Slide><IconCircle icon={MockIcon} /></Slide>);
    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });
});

describe('StatBox', () => {
  it('renders value and label', () => {
    render(<Slide><StatBox value="200K+" label="Signals / Day" /></Slide>);
    expect(screen.getByText('200K+')).toBeInTheDocument();
    expect(screen.getByText('Signals / Day')).toBeInTheDocument();
  });

  it('renders with icon', () => {
    render(<Slide><StatBox icon={MockIcon} value="42" label="Count" /></Slide>);
    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });
});

describe('Step', () => {
  it('renders step number and text', () => {
    render(<Slide><Step n={1}>First step</Step></Slide>);
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('First step')).toBeInTheDocument();
  });
});

describe('Pipeline', () => {
  it('renders all pipeline items', () => {
    render(
      <Slide>
        <Pipeline
          items={[
            { icon: MockIcon, label: 'Step A', sub: 'Desc A' },
            { icon: MockIcon, label: 'Step B', sub: 'Desc B' },
          ]}
        />
      </Slide>,
    );
    expect(screen.getByText('Step A')).toBeInTheDocument();
    expect(screen.getByText('Step B')).toBeInTheDocument();
    expect(screen.getByText('Desc A')).toBeInTheDocument();
  });
});
