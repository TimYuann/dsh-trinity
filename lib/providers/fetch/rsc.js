// lib/providers/fetch/rsc.js — Next.js self.__next_f.push parser (DESIGN §1.13)
// Pure string + JSON.parse; zero npm deps.

const RSC_MARKER = 'self.__next_f.push'
const CHUNK_RE = /<script>self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)<\/script>/g

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isRSCBody(text) {
  return typeof text === 'string' && text.includes(RSC_MARKER)
}

/**
 * @param {string} text
 * @returns {{ title: string, content: string } | null}
 */
export function extractRSCContent(text) {
  if (!isRSCBody(text)) return null
  const chunks = new Map()
  let m
  CHUNK_RE.lastIndex = 0
  while ((m = CHUNK_RE.exec(text)) !== null) {
    const body = m[1]
    if (!body) continue
    const lines = body.split('\n')
    for (const line of lines) {
      const colon = line.indexOf(':')
      if (colon <= 0) continue
      const id = line.slice(0, colon).trim()
      if (!/^[0-9a-f]{1,4}$/i.test(id)) continue
      const payload = line.slice(colon + 1)
      try {
        chunks.set(id, JSON.parse(payload))
      } catch { /* malformed line */ }
    }
  }
  if (chunks.size === 0) return null

  const seen = new Set()
  const markdownLines = []
  const titles = []

  function renderNode(node, depth) {
    if (!node || depth > 8) return ''
    if (typeof node === 'string') return node
    if (typeof node === 'number' || typeof node === 'boolean') return String(node)
    if (Array.isArray(node)) {
      if (node.length === 0) return ''
      // RSC element tuple: ["$", tag, key, props]
      if (node[0] === '$' && typeof node[1] === 'string') {
        const tag = node[1].toLowerCase()
        const props = (node[3] && typeof node[3] === 'object') ? node[3] : {}
        const children = renderChildren(props.children, depth + 1)
        switch (tag) {
          case 'h1': return `# ${children}\n\n`
          case 'h2': return `## ${children}\n\n`
          case 'h3': return `### ${children}\n\n`
          case 'h4': return `#### ${children}\n\n`
          case 'h5': return `##### ${children}\n\n`
          case 'h6': return `###### ${children}\n\n`
          case 'p': return `${children}\n\n`
          case 'code': return '`' + children + '`'
          case 'pre': return '```\n' + children + '\n```\n\n'
          case 'strong': return `**${children}**`
          case 'em': return `*${children}*`
          case 'li': return `- ${children}\n`
          case 'blockquote': return `> ${children}\n\n`
          case 'a': return `[${children}](${props.href || ''})`
          case 'table': return `${children}\n\n`
          case 'title': titles.push(children); return ''
          default: return children
        }
      }
      return node.map((n) => renderNode(n, depth + 1)).join('')
    }
    if (typeof node === 'object') {
      return renderChildren(node.children, depth + 1)
    }
    return ''
  }

  function renderChildren(children, depth) {
    if (children == null) return ''
    if (Array.isArray(children)) return children.map((c) => renderNode(c, depth)).join('')
    // Reference like "$L23"
    if (typeof children === 'string' && children.startsWith('$L')) {
      const id = children.slice(2)
      if (seen.has(id)) return ''
      seen.add(id)
      const target = chunks.get(id)
      if (target === undefined) return ''
      return renderNode(target, depth + 1)
    }
    return renderNode(children, depth)
  }

  // Prefer chunk '23' (Next.js convention for the main payload)
  const orderedIds = chunks.has('23') ? ['23', ...Array.from(chunks.keys()).filter((k) => k !== '23')] : Array.from(chunks.keys())
  for (const id of orderedIds) {
    if (seen.has(id)) continue
    const node = chunks.get(id)
    markdownLines.push(renderNode(node, 0))
  }

  const content = markdownLines.join('').trim()
  if (content.length < 100) return null
  return { title: titles[0] || '', content }
}