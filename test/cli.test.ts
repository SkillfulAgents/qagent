import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/cli.ts'

describe('parseArgs', () => {
  it('defaults to "run" command with sensible options', () => {
    const { command, options } = parseArgs(['run'])
    expect(command).toBe('run')
    expect(options.verbose).toBe(false)
    expect(options.maxRetries).toBe(1)
    expect(options.baseUrl).toBe('http://localhost:3000')
  })

  it('parses --filter with a value', () => {
    const { options } = parseArgs(['run', '--filter', 'login'])
    expect(options.filter).toBe('login')
  })

  it('parses --retries with a numeric value', () => {
    const { options } = parseArgs(['run', '--retries', '3'])
    expect(options.maxRetries).toBe(3)
  })

  it('parses --model and --base-url', () => {
    const { options } = parseArgs(['run', '--model', 'opus', '--base-url', 'http://example.com'])
    expect(options.model).toBe('opus')
    expect(options.baseUrl).toBe('http://example.com')
  })

  it('parses boolean flags', () => {
    const { options } = parseArgs(['run', '--verbose', '--record', '--headless', '--append', '--upload'])
    expect(options.verbose).toBe(true)
    expect(options.record).toBe(true)
    expect(options.headless).toBe(true)
    expect(options.append).toBe(true)
    expect(options.upload).toBe(true)
  })

  it('parses --budget as a float', () => {
    const { options } = parseArgs(['run', '--budget', '2.5'])
    expect(options.budgetOverride).toBe(2.5)
  })

  it('throws when --filter is missing its value', () => {
    expect(() => parseArgs(['run', '--filter'])).toThrow('Missing value for --filter')
  })

  it('throws when --retries is missing its value', () => {
    expect(() => parseArgs(['run', '--retries'])).toThrow('Missing value for --retries')
  })

  it('throws when --base-url is missing its value', () => {
    expect(() => parseArgs(['run', '--base-url'])).toThrow('Missing value for --base-url')
  })

  it('throws when --model is missing its value', () => {
    expect(() => parseArgs(['run', '--model'])).toThrow('Missing value for --model')
  })

  it('throws when --budget is missing its value', () => {
    expect(() => parseArgs(['run', '--budget'])).toThrow('Missing value for --budget')
  })

  it('throws when value-flag is followed by another flag instead of a value', () => {
    expect(() => parseArgs(['run', '--filter', '--verbose'])).toThrow('Missing value for --filter')
  })
})
