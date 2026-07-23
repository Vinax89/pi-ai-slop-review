declare module "@earendil-works/pi-tui" {
  export class Text {
    constructor(text: string, x: number, y: number);
  }
}

declare module "@earendil-works/pi-ai/compat" {
  export interface UserMessage {
    role: "user";
    content: Array<{ type: "text"; text: string }>;
    timestamp: number;
  }
  export function complete(model: unknown, context: unknown, options: unknown): Promise<any>;
}

declare module "typebox" {
  interface SchemaOptions {
    description?: string;
    maxItems?: number;
  }

  export const Type: {
    Object(properties: Record<string, unknown>, options?: SchemaOptions): unknown;
    Optional(schema: unknown): unknown;
    Array(schema: unknown, options?: SchemaOptions): unknown;
    String(options?: SchemaOptions): unknown;
    Boolean(options?: SchemaOptions): unknown;
    Number(options?: SchemaOptions): unknown;
    Literal(value: string | number | boolean): unknown;
    Record(key: unknown, value: unknown): unknown;
  };
}
