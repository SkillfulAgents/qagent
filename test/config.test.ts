import { describe, expect, it } from 'vitest'
import { parseEnvContent } from '../src/core/config.ts'

describe('parseEnvContent', () => {
  it('parses simple KEY=value pairs', () => {
    const entries = parseEnvContent('FOO=bar\nBAZ=qux\n')
    expect(entries).toEqual([['FOO', 'bar'], ['BAZ', 'qux']])
  })

  it('strips surrounding double quotes from values', () => {
    const entries = parseEnvContent('FOO="bar baz"\n')
    expect(entries).toEqual([['FOO', 'bar baz']])
  })

  it('strips surrounding single quotes from values', () => {
    const entries = parseEnvContent("FOO='bar baz'\n")
    expect(entries).toEqual([['FOO', 'bar baz']])
  })

  it('does not strip mismatched quotes', () => {
    const entries = parseEnvContent('FOO="bar\n')
    expect(entries).toEqual([['FOO', '"bar']])
  })

  it('handles export prefix', () => {
    const entries = parseEnvContent('export FOO=bar\nexport BAZ="qux"\n')
    expect(entries).toEqual([['FOO', 'bar'], ['BAZ', 'qux']])
  })

  it('skips comments and blank lines', () => {
    const input = `
# This is a comment
FOO=bar

  # indented comment

BAZ=qux
`
    const entries = parseEnvContent(input)
    expect(entries).toEqual([['FOO', 'bar'], ['BAZ', 'qux']])
  })

  it('skips lines without = sign', () => {
    const entries = parseEnvContent('NOEQUALSSIGN\nFOO=bar\n')
    expect(entries).toEqual([['FOO', 'bar']])
  })

  it('handles values containing = signs', () => {
    const entries = parseEnvContent('FOO=bar=baz=qux\n')
    expect(entries).toEqual([['FOO', 'bar=baz=qux']])
  })

  it('handles empty values', () => {
    const entries = parseEnvContent('FOO=\nBAR=\n')
    expect(entries).toEqual([['FOO', ''], ['BAR', '']])
  })

  it('trims whitespace around keys and values', () => {
    const entries = parseEnvContent('  FOO  =  bar  \n')
    expect(entries).toEqual([['FOO', 'bar']])
  })
})
