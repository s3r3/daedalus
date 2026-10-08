import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { Split } from '../Split';
import { Animate } from '../Animate';
import { Stagger } from '../Stagger';
import { IconCircle } from '../IconCircle';
import { Accordion } from '../Accordion';
import { DataTable } from '../DataTable';
import { Pipeline } from '../Pipeline';
import { Sortable } from '../Sortable';
import { Tabs } from '../Tabs';
import { Chart } from '../Chart';
import { CountUp } from '../CountUp';
import { TypeWriter } from '../TypeWriter';
import { Card } from '../Card';
import { Heading } from '../Heading';
import { GradientText } from '../GradientText';
import { Grid } from '../Grid';
import { Stack } from '../Stack';
import { Row } from '../Row';
import { Spacer } from '../Spacer';
import { Slide } from '../Slide';

afterEach(cleanup);

const MockIcon = ({ size, style }: { size?: number; style?: React.CSSProperties }) => (
  <svg data-testid="icon" width={size} height={size} style={style} />
);

// ── Critical crash paths (map lookups that crash on invalid keys) ──

describe('Split - crash proof', () => {
  it('handles invalid ratio gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <Split ratio={'55/45' as any}>
            <div>A</div>
            <div>B</div>
          </Split>
        </Slide>,
      ),
    ).not.toThrow();
  });

  it('handles completely bogus ratio', () => {
    expect(() =>
      render(
        <Slide>
          <Split ratio={'banana' as any}>
            <div>A</div>
            <div>B</div>
          </Split>
        </Slide>,
      ),
    ).not.toThrow();
  });
});

describe('Animate - crash proof', () => {
  it('handles invalid effect gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <Animate effect={'zoom-in' as any}>
            <div>Content</div>
          </Animate>
        </Slide>,
      ),
    ).not.toThrow();
  });
});

describe('Stagger - crash proof', () => {
  it('handles invalid effect gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <Stagger effect={'spin' as any}>
            <div>A</div>
            <div>B</div>
          </Stagger>
        </Slide>,
      ),
    ).not.toThrow();
  });
});

describe('IconCircle - crash proof', () => {
  it('handles invalid size gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <IconCircle icon={MockIcon} size={'xl' as any} />
        </Slide>,
      ),
    ).not.toThrow();
  });
});

// ── Array prop crashes (.map on undefined) ──

describe('Accordion - crash proof', () => {
  it('handles undefined items gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <Accordion items={undefined as any} />
        </Slide>,
      ),
    ).not.toThrow();
  });
});

describe('DataTable - crash proof', () => {
  it('handles undefined headers and rows gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <DataTable headers={undefined as any} rows={undefined as any} />
        </Slide>,
      ),
    ).not.toThrow();
  });
});

describe('Pipeline - crash proof', () => {
  it('handles undefined items gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <Pipeline items={undefined as any} />
        </Slide>,
      ),
    ).not.toThrow();
  });
});

describe('Sortable - crash proof', () => {
  it('handles undefined items gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <Sortable items={undefined as any} />
        </Slide>,
      ),
    ).not.toThrow();
  });
});

describe('Tabs - crash proof', () => {
  it('handles undefined items gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <Tabs items={undefined as any} />
        </Slide>,
      ),
    ).not.toThrow();
  });
});

describe('Chart - crash proof', () => {
  it('handles undefined data gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <Chart type="bar" data={undefined as any} />
        </Slide>,
      ),
    ).not.toThrow();
  });

  it('handles invalid type gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <Chart type={'scatter' as any} data={[]} />
        </Slide>,
      ),
    ).not.toThrow();
  });
});

// ── Edge case guards ──

describe('CountUp - crash proof', () => {
  it('handles negative decimals gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <CountUp to={100} decimals={-5} />
        </Slide>,
      ),
    ).not.toThrow();
  });

  it('handles excessive decimals gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <CountUp to={100} decimals={100} />
        </Slide>,
      ),
    ).not.toThrow();
  });
});

describe('TypeWriter - crash proof', () => {
  it('handles non-string text gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <TypeWriter text={42 as any} />
        </Slide>,
      ),
    ).not.toThrow();
  });

  it('handles undefined text gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <TypeWriter text={undefined as any} />
        </Slide>,
      ),
    ).not.toThrow();
  });
});

// ── Silent failure fallbacks (invalid size/gap props) ──

describe('Card - crash proof', () => {
  it('handles invalid pad gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <Card pad={'xl' as any}>Content</Card>
        </Slide>,
      ),
    ).not.toThrow();
  });
});

describe('Heading - crash proof', () => {
  it('handles invalid size gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <Heading size={'xxl' as any}>Title</Heading>
        </Slide>,
      ),
    ).not.toThrow();
  });
});

describe('GradientText - crash proof', () => {
  it('handles invalid size gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <GradientText size={'tiny' as any}>Title</GradientText>
        </Slide>,
      ),
    ).not.toThrow();
  });
});

describe('Grid - crash proof', () => {
  it('handles invalid gap gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <Grid gap={'xl' as any}>
            <div>A</div>
          </Grid>
        </Slide>,
      ),
    ).not.toThrow();
  });
});

describe('Stack - crash proof', () => {
  it('handles invalid gap gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <Stack gap={'huge' as any}>
            <div>A</div>
          </Stack>
        </Slide>,
      ),
    ).not.toThrow();
  });
});

describe('Row - crash proof', () => {
  it('handles invalid gap gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <Row gap={'xl' as any}>
            <div>A</div>
          </Row>
        </Slide>,
      ),
    ).not.toThrow();
  });
});

describe('Spacer - crash proof', () => {
  it('handles invalid size gracefully', () => {
    expect(() =>
      render(
        <Slide>
          <Spacer size={'xxl' as any} />
        </Slide>,
      ),
    ).not.toThrow();
  });
});

describe('Slide - crash proof', () => {
  it('handles invalid layout gracefully', () => {
    expect(() =>
      render(
        <Slide layout={'fullbleed' as any}>
          <div>Content</div>
        </Slide>,
      ),
    ).not.toThrow();
  });
});
