import {
  ArgumentMetadata,
  BadRequestException,
  PipeTransform,
} from "@nestjs/common";
import { ZodSchema } from "zod";

export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(
        result.error.issues.map(
          (i) => `${i.path.join(".") || "body"}: ${i.message}`,
        ),
      );
    }
    return result.data;
  }
}
