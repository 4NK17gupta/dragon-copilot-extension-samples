import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { DynamicForm } from '../DynamicForm';
import type { DynamicFormHandle } from '../DynamicForm';

type FormInputs = ComponentProps<typeof DynamicForm>['inputs'];

// Mirrors the ContractBased sample's inputs and the generated report / patient-information schemas.
const contractBasedInputs: FormInputs = [
  {
    name: 'report',
    description: 'The radiology report.',
    contentType: 'application/vnd.ms-dragon.rad.report+json',
    required: true,
    schema: {
      type: 'object',
      required: ['reportText'],
      properties: {
        reportText: { type: 'string', description: 'The radiology report text.' },
      },
    },
  },
  {
    name: 'patientInformation',
    description: 'Patient demographics.',
    contentType: 'application/vnd.ms-dragon.rad.patient-information+json',
    required: false,
    schema: {
      type: 'object',
      properties: {
        dateOfBirth: {
          type: 'string',
          format: 'date',
          description: 'The date of birth of the patient in YYYY-MM-DD format.',
        },
        biologicalSex: {
          type: 'string',
          description: 'The sex of the patient.',
          enum: ['Male', 'Female', 'Unknown', 'Other'],
        },
      },
    },
  },
];

function renderForm(
  inputs: FormInputs = contractBasedInputs,
  onChange = vi.fn(),
  ref = createRef<DynamicFormHandle>(),
) {
  render(
    <FluentProvider theme={webLightTheme}>
      <DynamicForm ref={ref} inputs={inputs} values={{}} onChange={onChange} />
    </FluentProvider>,
  );
  return { onChange, ref };
}

describe('DynamicForm', () => {
  it('shows no hint text or type badges under the fields', () => {
    renderForm();

    for (const hint of [
      'The radiology report text.',
      'The date of birth of the patient in YYYY-MM-DD format.',
      'The sex of the patient.',
    ]) {
      expect(screen.getByText(hint)).not.toBeVisible();
    }
    expect(screen.queryByText(/^date$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^dropdown$/i)).not.toBeInTheDocument();
  });

  it('labels each control and announces its description', () => {
    renderForm();

    const reportText = screen.getByRole('textbox', { name: 'Report Text' });
    expect(reportText).toHaveAttribute('placeholder', 'Enter Report Text');
    expect(reportText).toHaveAccessibleDescription('The radiology report text.');

    const dateOfBirth = screen.getByLabelText('Date of Birth');
    expect(dateOfBirth).toHaveAttribute('type', 'date');
    expect(dateOfBirth).toHaveAccessibleDescription('The date of birth of the patient in YYYY-MM-DD format.');

    const biologicalSex = screen.getByRole('combobox', { name: 'Biological Sex' });
    expect(biologicalSex).toHaveAccessibleDescription('The sex of the patient.');
  });

  it('links number and checkbox controls the same way', () => {
    renderForm([
      {
        name: 'options',
        description: 'Run options.',
        contentType: 'application/json',
        required: false,
        schema: {
          type: 'object',
          properties: {
            maxFindings: { type: 'integer', description: 'Most findings to return.' },
            includeImages: { type: 'boolean', description: 'Attach key images.' },
          },
        },
      },
    ]);

    const maxFindings = screen.getByRole('spinbutton', { name: 'Max Findings' });
    expect(maxFindings).toHaveAttribute('placeholder', 'Enter Max Findings');
    expect(maxFindings).toHaveAccessibleDescription('Most findings to return.');
    expect(screen.getByRole('checkbox', { name: 'Include Images' })).toHaveAccessibleDescription('Attach key images.');
  });

  it('submits the date of birth as YYYY-MM-DD', () => {
    const { onChange } = renderForm();

    fireEvent.change(screen.getByLabelText('Date of Birth'), { target: { value: '1990-01-15' } });

    expect(onChange).toHaveBeenCalledWith('patientInformation.dateOfBirth', '1990-01-15');
  });

  it('still shows the required message when validated', () => {
    const { ref } = renderForm();

    let valid = true;
    act(() => {
      valid = ref.current!.validate();
    });

    expect(valid).toBe(false);
    expect(screen.getByText('Report Text is required')).toBeVisible();
  });
});
