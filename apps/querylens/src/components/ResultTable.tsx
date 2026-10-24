import { fmtCell, type Table } from '@labs/data-core'

export function ResultTable({ table }: { table: Table }) {
  if (table.rows.length === 0) return <p className="empty">No rows matched for this range.</p>
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {table.columns.map((column) => (
              <th key={column.key} scope="col" className={column.align === 'right' ? 'right' : undefined}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {table.columns.map((column, columnIndex) => (
                <td key={column.key} className={column.align === 'right' ? 'right' : undefined}>
                  {fmtCell(row[columnIndex] ?? null, column.format)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
