import { parseInline, parseMarkdown } from '../lib/markdown.js'

function Inline({ text }) {
  return parseInline(text).map((run, index) => {
    if (run.bold) return <strong key={index}>{run.text}</strong>
    if (run.italic) return <em key={index}>{run.text}</em>
    if (run.code) return <code key={index}>{run.text}</code>
    return <span key={index}>{run.text}</span>
  })
}

const number = (value) => value.toLocaleString('en-US', { maximumFractionDigits: 1 })

/** A horizontal bar chart from a ```chart block, drawn with plain elements. */
function BarChart({ chart }) {
  const max = Math.max(...chart.bars.map((bar) => bar.value), 0) || 1
  return (
    <figure className="markdown-chart" dir="auto">
      {chart.title && <figcaption>{chart.title}</figcaption>}
      <ul aria-label={chart.title || 'Chart'}>
        {chart.bars.map((bar, index) => (
          <li key={index}>
            <span className="chart-label" title={bar.label}>
              {bar.label}
            </span>
            <span className="chart-track" aria-hidden="true">
              <span className="chart-bar" style={{ width: `${Math.max((bar.value / max) * 100, bar.value > 0 ? 2 : 0)}%` }} />
            </span>
            <span className="chart-value">
              {number(bar.value)}
              {chart.unit ? ` ${chart.unit}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  )
}

/** Renders the assistant's Markdown as React elements - never as HTML. */
export default function Markdown({ text }) {
  return (
    <div className="markdown" dir="auto">
      {parseMarkdown(text).map((block, index) => {
        if (block.type === 'chart') return <BarChart key={index} chart={block} />
        if (block.type === 'code') {
          return (
            <pre key={index} className="markdown-code">
              {block.text}
            </pre>
          )
        }
        if (block.type === 'heading') {
          const Tag = block.level <= 2 ? 'h3' : 'h4'
          return (
            <Tag key={index} dir="auto">
              <Inline text={block.text} />
            </Tag>
          )
        }
        if (block.type === 'list') {
          const Tag = block.ordered ? 'ol' : 'ul'
          return (
            <Tag key={index} dir="auto">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  <Inline text={item} />
                </li>
              ))}
            </Tag>
          )
        }
        if (block.type === 'table') {
          return (
            <div className="markdown-table" key={index}>
              <table dir="auto">
                <thead>
                  <tr>
                    {block.header.map((cell, cellIndex) => (
                      <th key={cellIndex}>
                        <Inline text={cell} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex}>
                          <Inline text={cell} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
        return (
          <p key={index} dir="auto">
            <Inline text={block.text} />
          </p>
        )
      })}
    </div>
  )
}
