import { defineRule, type ESTree } from "@oxlint/plugins";
import { hasUiTranslation } from "@t3tools/shared/uiLocale";

const COPY_PROPS = new Set([
  "title",
  "description",
  "label",
  "aria-label",
  "placeholder",
  "context",
]);
const isCopy = (text: string) => /\p{Letter}/u.test(text);

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Require translated copy in migrated UI flows and known translation keys.",
    },
  },
  create(context) {
    const gtComponents = new Set<string>();
    const isGtElement = (node: ESTree.JSXElement) => {
      const name = node.openingElement.name;
      return name.type === "JSXIdentifier" && gtComponents.has(name.name);
    };
    const insideGtElement = (node: ESTree.Node) => {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.type === "JSXAttribute") return false;
        if (parent.type === "JSXElement" && isGtElement(parent)) return true;
      }
      return false;
    };
    const report = (node: ESTree.Node) =>
      context.report({
        node,
        message:
          'Use t("message", values) or a GT translation for UI copy. Add Simplified Chinese to its catalog; keep user content as data.',
      });
    const copyExpression = (node: ESTree.Node) => {
      if (node.type === "Literal" && typeof node.value === "string" && isCopy(node.value)) {
        report(node);
      } else if (
        node.type === "TemplateLiteral" &&
        node.quasis.some((part) => isCopy(part.value.raw))
      ) {
        report(node);
      } else if (node.type === "ConditionalExpression") {
        copyExpression(node.consequent);
        copyExpression(node.alternate);
      }
    };
    const translationKey = (node: ESTree.Node) => {
      if (node.type === "Literal" && typeof node.value === "string") {
        if (!hasUiTranslation(node.value) && isCopy(node.value)) report(node);
      } else if (node.type === "TemplateLiteral") {
        if (node.expressions.length > 0) report(node);
        else if (!hasUiTranslation(node.quasis[0]?.value.cooked ?? "")) report(node);
      } else if (node.type === "ConditionalExpression") {
        translationKey(node.consequent);
        translationKey(node.alternate);
      }
    };
    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        if (node.source.value !== "gt-react" && node.source.value !== "gt-react-native") return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.importKind !== "type" &&
            specifier.imported.type === "Identifier" &&
            specifier.imported.name === "T"
          ) {
            gtComponents.add(specifier.local.name);
          }
        }
      },
      JSXText(node) {
        const parent = node.parent;
        const name = parent?.type === "JSXElement" ? parent.openingElement.name : undefined;
        // Code and key names are syntax, not interface copy.
        if (name?.type === "JSXIdentifier" && ["code", "pre", "kbd"].includes(name.name)) return;
        if (isCopy(node.value) && !insideGtElement(node)) report(node);
      },
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || !COPY_PROPS.has(node.name.name) || !node.value)
          return;
        const element = node.parent.parent;
        if (node.name.name === "context" && element?.type === "JSXElement" && isGtElement(element))
          return;
        if (node.value.type === "Literal") copyExpression(node.value);
      },
      Property(node) {
        const key = node.key;
        const name =
          key.type === "Identifier" ? key.name : key.type === "Literal" ? key.value : null;
        if (!node.computed && typeof name === "string" && COPY_PROPS.has(name)) {
          copyExpression(node.value);
        }
      },
      JSXExpressionContainer(node) {
        if (node.parent?.type === "JSXAttribute") {
          const name = node.parent.name;
          if (name.type !== "JSXIdentifier" || !COPY_PROPS.has(name.name)) return;
        } else if (insideGtElement(node)) {
          return;
        }
        if (node.expression.type !== "JSXEmptyExpression") copyExpression(node.expression);
      },
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "t" && node.arguments[0]) {
          translationKey(node.arguments[0]);
        }
      },
    };
  },
});
