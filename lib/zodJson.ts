import { ZodFirstPartyTypeKind, type ZodTypeAny } from "zod";

/** Minimal Zod -> JSON Schema converter for the shapes the agents use (objects, arrays, enums, primitives). */
export function zodToJsonSchema(s: ZodTypeAny): Record<string, unknown> {
  const def = s._def as { typeName: ZodFirstPartyTypeKind; [k: string]: unknown };
  const desc = s.description ? { description: s.description } : {};
  switch (def.typeName) {
    case ZodFirstPartyTypeKind.ZodString:
      return { type: "string", ...desc };
    case ZodFirstPartyTypeKind.ZodNumber:
      return { type: "number", ...desc };
    case ZodFirstPartyTypeKind.ZodBoolean:
      return { type: "boolean", ...desc };
    case ZodFirstPartyTypeKind.ZodLiteral:
      return { const: def.value, ...desc };
    case ZodFirstPartyTypeKind.ZodEnum:
      return { type: "string", enum: def.values, ...desc };
    case ZodFirstPartyTypeKind.ZodArray:
      return { type: "array", items: zodToJsonSchema(def.type as ZodTypeAny), ...desc };
    case ZodFirstPartyTypeKind.ZodOptional:
    case ZodFirstPartyTypeKind.ZodNullable:
    case ZodFirstPartyTypeKind.ZodDefault:
      return zodToJsonSchema((def.innerType as ZodTypeAny) ?? (def as never));
    case ZodFirstPartyTypeKind.ZodRecord:
      return { type: "object", additionalProperties: zodToJsonSchema(def.valueType as ZodTypeAny), ...desc };
    case ZodFirstPartyTypeKind.ZodUnion:
      return { anyOf: (def.options as ZodTypeAny[]).map(zodToJsonSchema), ...desc };
    case ZodFirstPartyTypeKind.ZodObject: {
      const shape = (s as unknown as { shape: Record<string, ZodTypeAny> }).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = zodToJsonSchema(v);
        if (!v.isOptional()) required.push(k);
      }
      return { type: "object", properties, required, ...desc };
    }
    default:
      return {};
  }
}
