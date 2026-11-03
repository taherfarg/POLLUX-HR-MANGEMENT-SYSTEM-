import { parseInline, parseMarkdown } from '../lib/markdown.js'

function Inline({ text }) {
  return parseInline(text).map((run, index) => {
    if (run.bold) return <strong key={index}>{run.text}</strong>
    if (run.italic) return <em key={index}>{run.text}</em>
    if (run.code) return <code key={index}>{run.text}</code>
    return <span key={index}>{run.text}</span>
  })
}

/** Renders the assistant's Markdown as React elements - never as HTML. */
export default function Markdown({ text }) {
  return (
    <div className="markdown" dir="auto">
      {parseMarkdown(text).map((block, index) => {
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
