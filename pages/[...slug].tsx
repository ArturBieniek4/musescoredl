import type { GetServerSideProps } from "next";

type CatchAllPageProps = Record<string, never>;

export const getServerSideProps: GetServerSideProps<CatchAllPageProps> = async (
  context
) => {
  const slug = context.params?.slug;

  if (!Array.isArray(slug) || slug.length === 0) {
    return { notFound: true };
  }

  const museScoreUrl = `https://musescore.com/${slug.join("/")}`;

  return {
    redirect: {
      destination: `/api/download?url=${encodeURIComponent(museScoreUrl)}`,
      permanent: false,
    },
  };
};

export default function CatchAllPage() {
  return null;
}
