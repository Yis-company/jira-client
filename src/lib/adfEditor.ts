export type JsonRecord = Record<string, unknown>;

export type ADFEditConversion =
  | { safe: true; document: JsonRecord }
  | { safe: false; reason: string };

const nodeNames: Record<string, string> = {
  doc: "doc",
  paragraph: "paragraph",
  heading: "heading",
  bulletList: "bulletList",
  orderedList: "orderedList",
  listItem: "listItem",
  blockquote: "blockquote",
  codeBlock: "codeBlock",
  hardBreak: "hardBreak",
  rule: "horizontalRule",
  horizontalRule: "horizontalRule",
  text: "text",
};

const markNames: Record<string, string> = {
  strong: "bold",
  em: "italic",
  code: "code",
  strike: "strike",
  underline: "underline",
  link: "link",
};

export function adfToEditorDocument(value: unknown): ADFEditConversion {
  if (typeof value === "string") {
    return {
      safe: true,
      document: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: value }] },
        ],
      },
    };
  }
  if (value == null) {
    return {
      safe: true,
      document: { type: "doc", content: [{ type: "paragraph" }] },
    };
  }
  if (!isRecord(value) || value.type !== "doc") {
    return {
      safe: false,
      reason:
        "This description is not a Jira document that can be edited safely.",
    };
  }
  if (value.version !== 1 || !onlyKeys(value, ["type", "version", "content"])) {
    return {
      safe: false,
      reason: "This Jira document uses metadata the editor cannot preserve.",
    };
  }
  const converted = convertNode(value);
  return converted.safe ? { safe: true, document: converted.node } : converted;
}

export function editorDocumentToAdf(value: unknown): JsonRecord {
  if (!isRecord(value) || value.type !== "doc") {
    throw new Error("The description editor returned an invalid document.");
  }
  return serializeNode(value);
}

type NodeConversion =
  | { safe: true; node: JsonRecord }
  | { safe: false; reason: string };

function convertNode(value: unknown): NodeConversion {
  if (!isRecord(value) || typeof value.type !== "string") {
    return {
      safe: false,
      reason:
        "This description contains a Jira element the editor cannot preserve.",
    };
  }
  const type = value.type;
  if (!nodeNames[type] || type === "horizontalRule") {
    return {
      safe: false,
      reason: `This description contains a ${type} element that stays read-only to protect Jira content.`,
    };
  }
  if (type === "text") {
    if (
      typeof value.text !== "string" ||
      !onlyKeys(value, ["type", "text", "marks"])
    ) {
      return {
        safe: false,
        reason:
          "This description contains text metadata the editor cannot preserve.",
      };
    }
    const marks = value.marks;
    if (marks !== undefined && !Array.isArray(marks)) {
      return {
        safe: false,
        reason:
          "This description contains formatting the editor cannot preserve.",
      };
    }
    const convertedMarks: JsonRecord[] = [];
    for (const mark of marks ?? []) {
      if (
        !isRecord(mark) ||
        typeof mark.type !== "string" ||
        !markNames[mark.type]
      ) {
        return {
          safe: false,
          reason:
            "This description contains formatting the editor cannot preserve.",
        };
      }
      if (!onlyKeys(mark, ["type", "attrs"])) {
        return {
          safe: false,
          reason:
            "This description contains formatting metadata the editor cannot preserve.",
        };
      }
      if (mark.type === "link") {
        if (
          !isRecord(mark.attrs) ||
          !onlyKeys(mark.attrs, ["href"]) ||
          !safeHttpUrl(mark.attrs.href)
        ) {
          return {
            safe: false,
            reason:
              "This description contains a link format the editor cannot preserve safely.",
          };
        }
        convertedMarks.push({ type: "link", attrs: { href: mark.attrs.href } });
      } else if (
        mark.attrs !== undefined &&
        (!isRecord(mark.attrs) || Object.keys(mark.attrs).length > 0)
      ) {
        return {
          safe: false,
          reason:
            "This description contains formatting attributes the editor cannot preserve.",
        };
      } else {
        convertedMarks.push({ type: markNames[mark.type] });
      }
    }
    return {
      safe: true,
      node: {
        type: "text",
        text: value.text,
        ...(convertedMarks.length ? { marks: convertedMarks } : {}),
      },
    };
  }

  if (type === "doc") {
    if (
      !onlyKeys(value, ["type", "version", "content"]) ||
      value.version !== 1
    ) {
      return {
        safe: false,
        reason: "This Jira document uses metadata the editor cannot preserve.",
      };
    }
  } else if (type === "heading") {
    if (
      !isRecord(value.attrs) ||
      !onlyKeys(value, ["type", "attrs", "content"]) ||
      !onlyKeys(value.attrs, ["level"]) ||
      !isIntegerIn(value.attrs.level, 1, 6)
    ) {
      return {
        safe: false,
        reason:
          "This description uses a heading format the editor cannot preserve.",
      };
    }
  } else if (type === "orderedList") {
    const attrs = asRecord(value.attrs);
    const validAttrs =
      value.attrs === undefined ||
      (attrs !== null &&
        onlyKeys(attrs, ["order"]) &&
        (attrs.order === undefined ||
          isIntegerIn(attrs.order, 1, Number.MAX_SAFE_INTEGER)));
    if (!onlyKeys(value, ["type", "attrs", "content"]) || !validAttrs) {
      return {
        safe: false,
        reason:
          "This description uses list metadata the editor cannot preserve.",
      };
    }
  } else if (type === "codeBlock") {
    const attrs = asRecord(value.attrs);
    if (
      !onlyKeys(value, ["type", "attrs", "content"]) ||
      (value.attrs !== undefined && (!attrs || Object.keys(attrs).length > 0))
    ) {
      return {
        safe: false,
        reason:
          "This description uses code block metadata the editor cannot preserve.",
      };
    }
  } else if (type === "rule") {
    if (!onlyKeys(value, ["type"])) {
      return {
        safe: false,
        reason:
          "This description contains rule metadata the editor cannot preserve.",
      };
    }
  } else if (!onlyKeys(value, ["type", "content"])) {
    return {
      safe: false,
      reason:
        "This description contains node metadata the editor cannot preserve.",
    };
  }

  const output: JsonRecord = {
    type: type === "rule" ? "horizontalRule" : type,
  };
  if (type === "heading")
    output.attrs = { level: (value.attrs as JsonRecord).level };
  if (
    type === "orderedList" &&
    isRecord(value.attrs) &&
    value.attrs.order !== undefined
  )
    output.attrs = { start: value.attrs.order };
  if (value.content !== undefined) {
    if (!Array.isArray(value.content))
      return {
        safe: false,
        reason: "This description contains an invalid content group.",
      };
    const children: JsonRecord[] = [];
    for (const child of value.content) {
      const result = convertNode(child);
      if (!result.safe) return result;
      children.push(result.node);
    }
    output.content = children;
  }
  return { safe: true, node: output };
}

function serializeNode(value: JsonRecord): JsonRecord {
  const type = value.type as string;
  if (!nodeNames[type]) throw new Error(`Unsupported editor node: ${type}`);
  if (type === "horizontalRule") return { type: "rule" };
  if (type === "doc") {
    const content = Array.isArray(value.content)
      ? value.content.map(serializeNode)
      : [];
    return { type: "doc", version: 1, content };
  }
  if (type === "text") {
    if (typeof value.text !== "string")
      throw new Error("Invalid editor text node.");
    const marks = Array.isArray(value.marks)
      ? value.marks.map(serializeMark)
      : [];
    return { type, text: value.text, ...(marks.length ? { marks } : {}) };
  }
  const node: JsonRecord = { type };
  if (type === "heading") {
    const attrs = asRecord(value.attrs);
    if (!attrs || !isIntegerIn(attrs.level, 1, 6))
      throw new Error("Invalid editor heading.");
    node.attrs = { level: attrs.level };
  }
  if (type === "orderedList") {
    const attrs = asRecord(value.attrs);
    if (attrs?.start !== undefined && attrs.start !== 1)
      node.attrs = { order: attrs.start };
  }
  if (Array.isArray(value.content))
    node.content = value.content.map(serializeNode);
  return node;
}

function serializeMark(value: unknown): JsonRecord {
  if (!isRecord(value) || typeof value.type !== "string")
    throw new Error("Invalid editor formatting.");
  const type = Object.keys(markNames).find(
    (name) => markNames[name] === value.type,
  );
  if (!type) throw new Error(`Unsupported editor formatting: ${value.type}`);
  if (type === "link") {
    const attrs = asRecord(value.attrs);
    if (!attrs || !safeHttpUrl(attrs.href))
      throw new Error("Invalid editor link.");
    return { type, attrs: { href: attrs.href } };
  }
  return { type };
}

function safeHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
}

function onlyKeys(value: JsonRecord, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isIntegerIn(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}
